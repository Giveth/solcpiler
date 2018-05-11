const fs = require('fs');
const path = require('path');
const globby = require('globby');
const solcjs = require('solc');
const utils = require('web3-utils');
const { execSync, spawnSync } = require('child_process');

class BreakSignal {}

const SOLC_VERSION_REGEX = /\d\.\d\.\d+\+commit\.\w{8}/;

/**
 * determines the baseDir for resolving files. The baseDir is the first dir in the chain,
 * starting from process.cwd() which contains a package.json file. If no package.json file
 * is found, then baseDir is process.cwd()
 */
const resolveBaseDir = () => {
  let dir = process.cwd();
  const exists = () => fs.existsSync(path.join(dir, 'package.json'));

  while (!exists()) {
    const s = dir.split(path.sep);
    s.pop();
    dir = s.join(path.sep);

    if (dir === '' && !exists()) {
      dir = process.cwd();
      break;
    }
  }

  return dir;
};

const resolveBuildFile = (opts, contractName) =>
  path.join(opts.outputJsDir, `${contractName}.sol.js`);

/**
 * reads the build file and gathers all contract hashes & the _solcVersion
 *
 * @param {string} buildFile the generated build file to read the hashes from
 * @returns {object} k (contract path) : v (hash)
 */
const readMetadata = (buildFile) => {
  if (!fs.existsSync(buildFile)) return {};

  const build = require(require.resolve(buildFile, { paths: [process.cwd()] }));

  return Object.keys(build)
    .filter(k => k.endsWith('_keccak256') || k === '_solcVersion')
    .reduce((res, k) => {
      if (k === '_solcVersion') {
        if (build[k]) {
          const match = build[k].match(SOLC_VERSION_REGEX);
          res[k] = match ? match[0] : undefined;
        }
      } else {
        const file = k.split('_keccak256')[0].slice(1);
        res[file] = build[k];
      }
      return res;
    }, {});
};

class Solcpiler {
  constructor(opts, files) {
    this.opts = opts || {};
    this.sourceList = files;
    this.libs = undefined;
    this.sources = {};
    // need to keep deps separate b/c we load the source files to check the hashes
    // if all hashes match, we don't need to compile them. this.sources is passed to
    this.importSources = {};
    this.sourceHashes = {};
    this.remappings = {};
    this.fileMap = {};
    this.fileDeps = {};
    this.solc = solcjs;
    this.baseDir = resolveBaseDir();
  }

  compile() {
    if (!Array.isArray(this.sourceList) || this.sourceList.length === 0) {
      console.log('No files to compile');
      return;
    }

    const useNativeSolc = this.useNativeSolc();

    this.updateTime = new Date();
    Promise.all([...this.sourceList.map(f => this.loadFile(f))])
      .then(() => {
        this.sourceList.forEach(s => (this.fileMap[s] = path.join(process.cwd(), s)));

        this.generateStandardJson();

        if (!this.opts.quiet) console.log('\ncalculating contract hashes...\n');

        const currentSolcVersion = this.getCurrentSolcVersion(useNativeSolc);
        this.removeUnchangedSources(currentSolcVersion);

        if (Object.keys(this.sources).length === 0) throw new BreakSignal();

        // console.log(this.standardInput.sources);
        fs.writeFileSync(
          path.join(this.opts.outputSolDir, 'solcStandardInput.json'),
          JSON.stringify(this.standardInput, null, 2),
        );

        return useNativeSolc ? Promise.resolve() : this.setSolidityVersion();
      })
      .then(() => {
        if (!this.opts.quiet) {
          console.log(`compiling contracts...\n\n${Object.keys(this.sources).join('\n')}\n`);
        }

        const output = useNativeSolc
          ? this.compileNativeSolc()
          : JSON.parse(this.solc.compileStandardWrapper(JSON.stringify(this.standardInput), _path =>
            this.resolvePath(_path)));

        if (output.errors) {
          let hasError = false;

          if (!this.opts.quiet) console.log('\nErrors/Warnings:\n');
          output.errors.forEach((e) => {
            const isError = e.severity === 'error';
            hasError = hasError || isError;

            if (!isError && this.opts.quiet) return;
            console.log(`${e.severity.toUpperCase()}: ${e.formattedMessage}`);
          });

          if (hasError) {
            console.log('Compiler errors!\n');

            const parserError = output.errors.some(e => e.type === 'ParserError');
            if (useNativeSolc && parserError) {
              console.log('Is the native solc the correct version needed for your contracts? A ParserError occurred, which will be thrown before the `pragma` directive is checked.\n\n');
            }
            return;
          }
        }

        if (!this.opts.quiet) console.log('saving output...');

        Object.keys(this.sources).forEach(s => this.generateFiles(output, s));

        // remove some info from the output before writing
        Object.keys(output.sources).forEach((k) => {
          delete output.sources[k].ast;
          delete output.sources[k].legacyAST;
        });
        Object.keys(output.contracts).forEach((f) => {
          Object.keys(output.contracts[f]).forEach((k) => {
            delete output.contracts[f][k].evm.assembly;
            delete output.contracts[f][k].evm.legacyAssembly;
            delete output.contracts[f][k].evm.bytecode.opcodes;
            delete output.contracts[f][k].evm.deployedBytecode.opcodes;
          });
        });
        fs.writeFileSync(
          path.join(this.opts.outputSolDir, 'solcStandardOutput.json'),
          JSON.stringify(output, null, 2),
        );
      })
      .catch((e) => {
        if (e instanceof BreakSignal) {
          return;
        }
        console.error(e);
      });
  }

  /**
   * generates a solidity standard-json input file
   */
  generateStandardJson() {
    const standardInput = {
      language: 'Solidity',
      sources: {},
      settings: {
        remappings: [],
        optimizer: {
          enabled: true,
          runs: 200,
        },
        metadata: {
          useLiteralContent: true,
        },
        outputSelection: {
          '*': {
            '*': [
              'metadata',
              'evm.bytecode.object',
              'evm.bytecode.sourceMap',
              'abi',
              'evm.methodIdentifiers',
              'evm.deployedBytecode.object',
              'evm.deployedBytecode.sourceMap',
            ],
          },
        },
      },
    };

    Object.keys(this.sources).forEach((f) => {
      const addContract = (c) => {
        if (Object.keys(standardInput.sources).includes(c)) return;

        const fileUrl = `file://${this.fileMap[c]}`;

        const existingSourceKey = Object.keys(standardInput.sources).find(k =>
          standardInput.sources[k].urls.includes(fileUrl));

        let remap = `${c}=${existingSourceKey}`;

        // we use remappings here so we don't include duplicate sources
        if (existingSourceKey) {
          // sourceList files should not be remapped, need to swap
          if (this.sourceList.includes(c)) {
            standardInput.sources[c] = standardInput.sources[existingSourceKey];
            delete standardInput.sources[existingSourceKey];
            delete this.remappings[existingSourceKey];
            this.remappings[existingSourceKey] = c;
            remap = `${existingSourceKey}=${c}`;
          } else {
            this.remappings[c] = existingSourceKey;
          }

          if (!standardInput.settings.remappings.includes(remap)) {
            standardInput.settings.remappings.push(remap);
          }
          return;
        }

        standardInput.sources[c] = {
          keccak256: this.hashSource(c),
          urls: [fileUrl],
          content: this.sources[c] || this.importSources[c],
        };
      };

      addContract(f);

      // resolve all deps for this contract using regex b/c the solidity AST has
      // not been generated
      this.resolveImportsFromFile(f).forEach(addContract);
    });

    this.standardInput = standardInput;
  }

  /**
   * removes any contracts from this.standardInput that have not changed since the last compile
   */
  removeUnchangedSources(currentVersion) {
    const unchanged = [];

    Object.keys(this.sources).forEach((f) => {
      const contractName = f
        .split(path.sep)
        .pop()
        .replace('.sol', '');
      const buildFile = resolveBuildFile(this.opts, contractName);

      const prevMetadata = readMetadata(buildFile);
      // console.log(buildFile, prevMetadata);

      const prevVersion = prevMetadata._solcVersion;

      // different versions, so we need to recompile
      if (prevVersion !== currentVersion) return;

      delete prevMetadata._solcVersion;
      const prevHashes = Object.assign({}, prevMetadata);

      // build file wasn't found, so we need to compile
      if (Object.keys(prevHashes).length === 0) return;

      // resolve all deps for this contract using regex b/c the solidity AST has
      // not been generated
      const contracts = this.resolveImportsFromFile(f);
      contracts.push(f);

      const contractHashes = contracts.reduce((val, c) => {
        val[c] = this.hashSource(c);
        return val;
      }, {});

      if (Object.keys(prevHashes).length !== contracts.length) return;

      let hasChanged = false;
      contracts.forEach((c) => {
        if (!this.standardInput.sources[c]) c = this.remappings[c];
        if (this.standardInput.sources[c].keccak256 !== prevHashes[c]) hasChanged = true;
      });

      if (!hasChanged) unchanged.push(f);
    });

    if (unchanged.length > 0 && !this.opts.quiet) console.log('\n');
    unchanged.forEach((f) => {
      if (!this.opts.quiet) console.log(`skipping ${f}... contract and dependencies unchanged`);
      delete this.sources[f];
    });

    // determine what contracts we still need to compile
    const toCompile = Object.keys(this.sources).reduce((val, c) => {
      val.push(c);
      return val.concat(this.resolveImportsFromFile(c));
    }, []);

    // remove any contracts from standardInput that we don't need to compile
    this.standardInput.settings.remappings = this.standardInput.settings.remappings.filter(
      remap => toCompile.includes(remap.split("=")[0]));

    Object.keys(this.standardInput.sources)
      .filter(c => !toCompile.includes(c) && !this.standardInput.settings.remappings.find(remap => remap.split("=")[1] === c))
      .forEach(c => delete this.standardInput.sources[c]);

    if (unchanged.length > 0 && !this.opts.quiet) console.log('\n');
  }

  /**
   * recursively resolves imports for a contract using regex
   *
   * @param {string} sourceFile contract file to resolve imports for
   */
  resolveImportsFromFile(sourceFile) {
    if (this.fileDeps[sourceFile]) return this.fileDeps[sourceFile];

    let imports = [];

    const dirname = path.dirname(sourceFile);
    let prefix = '';
    if (dirname.startsWith('.')) {
      prefix = dirname.split(path.sep)[0] + path.sep;
    }

    const r = /^import[\s]*(['"])(.*)\1;/gm;
    const contract = this.sources[sourceFile] || this.importSources[sourceFile];

    // find all import statements
    const matches = contract ? contract.match(r) || [] : [];
    matches.forEach((i) => {
      const r2 = /import[\s]*(['"])(.*)\1;/;
      const importFile = r2.exec(i)[2];

      // even though a leading './' isn't needed to resolve the file, _path needs to
      // match how solidity will look for the file when calling the importCallback (resolvePath),
      // so we can return the already loaded file, as well as to sanity check the deps that we find
      // here w/ what solidity returns
      const _path = importFile.startsWith('.')
        ? prefix + path.join(dirname, importFile)
        : importFile;

      // loads the contract file if necessary
      if (!this.sources[_path] && !this.importSources[_path]) {
        const res = this.resolvePath(_path);
        if (res.error) throw new Error(`Missing source for ${i}\n${res.error}`);
      }

      imports = imports.concat([...this.resolveImportsFromFile(_path), _path]);
    });

    const deps = Array.from(new Set(imports));
    this.fileDeps[sourceFile] = deps;
    return deps;
  }

  /**
   * Generates the *.sol.js, *_all.sol & *.json files for the provided sourceFile, using the provided
   * compiler output.
   *
   * @param {object} output solcjs compiler output
   * @param {string} sourceFile the contract to generate files for
   */
  generateFiles(output, sourceFile) {
    const contractFiles = this.resolveImportsFromFile(sourceFile);
    contractFiles.push(sourceFile);

    const sourceCodes = Object.keys(output.sources).map(cName => this.standardInput.sources[cName].content);

    // TODO remove this when sol-cov can handle artifacts specifying paths
    const sources = Object.keys(output.sources).reduce((val, name) => {
      const n = this.standardInput.sources[name].urls[0].replace('file://', '');
      val[n] = output.sources[name];
      return val;
  }, {});

    // generate js file
    let js = '/* This is an autogenerated file. DO NOT EDIT MANUALLY */\n\n';

    contractFiles.forEach((f) => {
      if (!output.contracts[f]) f = this.remappings[f];
      if (!output.contracts[f]) return;

      Object.keys(output.contracts[f]).forEach((contractName) => {
        const contract = output.contracts[f][contractName];
        const abi = JSON.stringify(contract.abi);
        const byteCode = contract.evm.bytecode.object;
        const runtimeByteCode = contract.evm.deployedBytecode.object;
        js += `exports.${contractName}Abi = ${abi}\n`;
        js += `exports.${contractName}ByteCode = "0x${byteCode}"\n`;
        js += `exports.${contractName}RuntimeByteCode = "0x${runtimeByteCode}"\n`;

        if (f === sourceFile) {
          // generate artifact file
          const sources = Object.keys(output.sources).reduce((val, name) => {
            const n = this.standardInput.sources[name].urls[0].replace('file://', '');
            val[n] = output.sources[name];
            return val;
          }, {});

          const c = Object.assign({}, contract);
          delete c.metadata;

          const artifact = {
            contractName,
            filePath: sourceFile,
            compilerOutput: c,
            sources,
            // sources: output.sources,
            sourceCodes,
            compiler: {
              name: this.useNativeSolc ? 'solc' : 'solcjs',
              keccak256: this.standardInput.sources[f].keccak256,
              version: this.compiledSolcVersion,
              settings: this.standardInput.settings,
            },
          };
          fs.writeFileSync(
            path.join(this.opts.outputArtifactsDir, `${contractName}.json`),
            JSON.stringify(artifact, null, 2),
          );
        }
      });
      js += `exports['_${f}_keccak256'] = "${this.standardInput.sources[f].keccak256}"\n`;
    });
    js += `exports._solcVersion = "${this.compiledSolcVersion}"\n`;

    const contractName = sourceFile
      .split(path.sep)
      .pop()
      .replace('.sol', '');
    fs.writeFileSync(resolveBuildFile(this.opts, contractName), js);

    // generate _all.sol file
    const r = /^import *"(.*)";/gm;

    let sol = '';
    contractFiles.forEach((c) => {
      if (!this.standardInput.sources[c] && this.remappings[c]) {
        c = this.remappings[c];
      }

      const contract = this.standardInput.sources[c].content;
      sol += `\n\n///File: ${c}\n\n${contract.replace(r, '')}`;
    });

    fs.writeFileSync(path.join(this.opts.outputSolDir, `${contractName}_all.sol`), sol);
  }

  /**
   * recursively resolves imports for a contract using the solidity AST
   *
   * @param {array} sources sources array from solc.compile results
   * @param {string} path the path of the contract to resolve imports for
   * @returns {array} ordered array of contracts imported by the contract specified by the path param
   */
  resolveImports(sources, path) {
    const ast = sources[path].AST;
    let imports = [];

    ast.children.filter(c => c.name === 'ImportDirective').forEach((i) => {
      const { absolutePath } = i.attributes;
      imports = imports.concat([...this.resolveImports(sources, absolutePath), absolutePath]);
    });

    return Array.from(new Set(imports));
  }

  /**
   * reads the contents of the provided sourceFile. If this file is a dependency,
   * then we add the contents to the importSources object, otherwise the contents
   * are added to the sources object.
   *
   * @param {string} sourceFile the file to load
   * @param {bool} isDep is this file a dependency of another contract
   */
  loadFile(sourceFile, isDep = false) {
    // check if we've already loaded this file
    if (this.sources[sourceFile] || this.importSources[sourceFile]) return Promise.resolve();

    if (this.opts.verbose) console.log('loading file ->', sourceFile);

    return new Promise((resolve, reject) => {
      fs.readFile(sourceFile, 'utf8', (err, _srcCode) => {
        if (err) return reject(err);

        if (isDep) this.importSources[sourceFile] = this.applyConstants(_srcCode);
        else this.sources[sourceFile] = this.applyConstants(_srcCode);
        resolve();
      });
    });
  }

  /**
   * sync version of loadFile. This is needed because solcjs resolveImports callback doesn't
   * work w/ async code
   */
  loadFileSync(sourceFile, isDep = false) {
    // check if we've already loaded this file
    if (this.sources[sourceFile] || this.importSources[sourceFile]) return;

    if (this.opts.verbose) console.log('loading file ->', sourceFile);

    const _srcCode = fs.readFileSync(sourceFile, 'utf8');
    if (isDep) this.importSources[sourceFile] = this.applyConstants(_srcCode);
    else this.sources[sourceFile] = this.applyConstants(_srcCode);
  }

  /**
   * Returns the contents of the contract at the given _path.
   *
   * @param {string} _path solidity path for the contract sources to resolve
   * @returns {object} obj w/ a single property 'contents' with the contract source
   */
  resolvePath(_path) {
    if (this.opts.verbose) console.log(`resolving import -> ${_path}`);

    if (this.sources[_path]) return { contents: this.sources[_path] };
    if (this.importSources[_path]) return { contents: this.importSources[_path] };

    const load = (f) => {
      this.loadFileSync(f, true);
      if (f !== _path) {
        this.fileMap[_path] = f;
        this.importSources[_path] = this.importSources[f];
        delete this.sources[f];
      }
      return { contents: this.importSources[_path] };
    };

    if (fs.existsSync(_path)) return load(_path);

    const contractImportFile = path.join(this.baseDir, 'contracts', _path);
    if (fs.existsSync(contractImportFile)) return load(contractImportFile);

    const srcImportFile = path.join(this.baseDir, 'src', _path);
    if (fs.existsSync(srcImportFile)) return load(srcImportFile);

    let npmImportFile;
    if (require.resolve.path) {
      npmImportFile = require.resolve(_path, { paths: [this.baseDir] });
    } else {
      npmImportFile = path.join(this.baseDir, 'node_modules', _path);
    }
    if (fs.existsSync(npmImportFile)) return load(npmImportFile);

    if (this.libs === undefined) {
      this.gatherLibs();
    }

    if (this.libs[_path]) return load(this.libs[_path]);

    return {
      error: `Looked in dir: ${_path}, contracts: ${contractImportFile}, src: ${srcImportFile}, npm: ${npmImportFile}, and libs`,
    };
  }

  /**
   * collect all contracts in the lib directory, the same way dapp-tools (https://github.com/dapphub/dapp)
   * resolves libs
   *
   * libs are imported like: "dir/contract" which could be a lib of a lib.
   *
   * ex: "ds-auth/auth.sol" could exist in the following locations:
   *   "lib/ds-auth/src/auth.sol"
   *   "lib/ds-token/lib/ds-auth/src/auth.sol"
   *
   * "index.sol" is imported via the package name
   *
   * ex: "ds-auth" could exist in the following locations:
   *   "lib/ds-auth/src/index.sol"
   *   "lib/ds-token/lib/ds-auth/src/index.sol"
   */
  gatherLibs() {
    const pattern = path.join(this.baseDir, 'lib', '**', 'src', '*.sol');
    if (this.opts.verbose) {
      console.log('\ncollecting lib contracts using glob pattern ->', pattern, '\n');
    }

    const libContracts = globby.sync(pattern);
    this.libs = {};
    libContracts.forEach((c) => {
      const s = c.split(path.sep).slice(-3);
      const contract = s[2] === 'index.sol' ? s[0] : path.join(s[0], s[2]);
      // libs are git submodules, so the same submodule may be included multiple times
      // we only keep the contract w/ the shortest path
      if (
        !this.libs[contract] ||
        c.split(path.sep).length < this.libs[contract].split(path.sep).length
      ) {
        this.libs[contract] = c;
      }
    });

    if (this.opts.verbose) {
      Object.keys(this.libs).forEach((l) => {
        console.log(`mapped ${l} -> ${this.libs[l]}`);
      });
      console.log('\n');
    }
  }

  /**
   * checks to see if solc is natively installed and if the version matches
   */
  useNativeSolc() {
    const res = spawnSync('solc', ['--version']);

    if (res.error || !res.stdout) return false;

    if (!this.opts.solcVersion) return true;

    const match = res.stdout.toString().match(SOLC_VERSION_REGEX);

    if (!match) return false;

    const v = this.opts.solcVersion.startsWith('v')
      ? this.opts.solcVersion.slice(1)
      : this.opts.solcVersion;

    if (match[0] === v) return true;

    if (!this.opts.quiet) {
      console.log(`\nnative solc found, but wrong version... need version ${v}\nusing solcjs`);
    }
    return false;
  }

  compileNativeSolc() {
    if (!this.opts.quiet) console.log('compiling contracts using native solc\n');

    const re = /(\d\.\d\.\d+\+commit.*)\n/;
    let res = execSync('solc --version');
    this.compiledSolcVersion = res.toString().match(re)[1];

    res = execSync('solc --standard-json', { input: JSON.stringify(this.standardInput) });
    return JSON.parse(res.toString());
  }

  getCurrentSolcVersion(useNativeSolc) {
    if (this.opts.solcVersion) {
      return this.opts.solcVersion.startsWith('v')
        ? this.opts.solcVersion.slice(1)
        : this.opts.solcVersion;
    }

    const res = useNativeSolc ? execSync('solc --version').toString() : this.solc.version();
    const match = res.match(SOLC_VERSION_REGEX);
    return match[0];
  }

  applyConstants(src) {
    let srcOut = src;

    Object.keys(this.opts).forEach((param) => {
      const value = this.opts[param];

      const rule = new RegExp(`constant ${param} = (.*);`, 'gm');
      const replacedText = `constant ${param} = ${value};`;

      srcOut = srcOut.replace(rule, replacedText);
    });

    return srcOut;
  }

  setSolidityVersion() {
    if (!this.opts.solcVersion) {
      this.compiledSolcVersion = this.solc.version();
      return Promise.resolve();
    }

    const v = this.opts.solcVersion.startsWith('v')
      ? this.opts.solcVersion.slice(1)
      : this.opts.solcVersion;
    if (this.solc.version().startsWith(v)) return;

    if (!this.opts.quiet) console.log('setting solc version', this.opts.solcVersion, '\n');

    return new Promise((resolve, reject) => {
      this.solc.loadRemoteVersion(this.opts.solcVersion, (err, _solc) => {
        if (err) return reject(err);
        this.solc = _solc;
        this.compiledSolcVersion = this.solc.version();
        resolve();
      });
    });
  }

  hashSource(f) {
    if (this.sourceHashes[f]) return this.sourceHashes[f];

    const source = this.sources[f] || this.importSources[f];
    const hash = utils.keccak256(source);

    this.sourceHashes[f] = hash;
    return hash;
  }
}

module.exports = Solcpiler;
