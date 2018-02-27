const fs = require('fs');
const path = require('path');
const glob = require('glob');
const solc = require('solc');
const crypto = require('crypto');

class BreakSignal { };

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
}

const resolveBuildFile = (opts, contractName) => {
    return path.join(opts.outputJsDir, `${contractName}.sol.js`);
}

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
        .filter(k => k.endsWith('_sha256') || k === '_solcVersion')
        .reduce((res, k) => {
            if (k === '_solcVersion') {
                res[k] = build[k];
            } else {
                const file = k.split('_sha256')[0].slice(1);
                res[file] = build[k];
            }
            return res;
        }, {});
}

class Solcpiler {
    constructor(opts, files) {
        this.opts = opts || {};
        this.files = files;
        this.libs = undefined;
        this.sources = {};
        // need to keep deps separate b/c we load the source files to check the hashes
        // if all hashes match, we don't need to compile them. this.sources is passed to
        // solc.compile.
        this.importSources = {};
        this.sourceHashes = {};
        this.solc = solc;
        this.baseDir = resolveBaseDir();
    }

    compile() {
        if (!Array.isArray(this.files) || this.files.length === 0) {
            console.log('No files to compile');
            return;
        }

        this.updateTime = new Date();
        Promise.all([
            ...this.files.map(f => this.loadFile(f))
        ])
            .then(() => {
                if (!this.opts.quiet) console.log('\ncalculating contract hashes...\n');
                this.removeUnchangedSources();

                if (Object.keys(this.sources).length === 0) throw new BreakSignal();

                return this.setSolidityVersion();
            })
            .then(() => {
                if (!this.opts.quiet) console.log(`compiling contracts...\n\n${Object.keys(this.sources).join('\n')}\n`);
                // Setting 1 as second parameter activates the optimizer
                const output = this.solc.compile({ sources: this.sources }, 1, (_path) => this.resolvePath(_path));
                if (!this.opts.quiet) console.log('\n');

                if (output.errors) {
                    let hasError = false;

                    if (!this.opts.quiet) console.log('\nErrors/Warnings:\n');
                    output.errors.forEach(e => {
                        const isError = e.includes('Error: ')
                        hasError = hasError || isError;

                        if (!isError && this.opts.quiet) return;
                        console.log(e);
                    });

                    if (hasError) {
                        console.log('Compiler errors!')
                        return;
                    }
                }

                if (!this.opts.quiet) console.log('saving output...');

                output.sourceList.forEach(s => this.generateFiles(output, s))

                // generate a combined.json file. This can be used to feed into evmlab for debugging
                Object.keys(output.contracts).forEach(c => {
                    const contract = output.contracts[c];
                    output.contracts[c] = {
                        functionHashes: contract.functionHashes,
                        gasEstimates: contract.gasEstimates,
                        abi: contract.interface,
                        bin: contract.bytecode,
                        'bin-runtime': contract.runtimeBytecode,
                        srcmap: contract.srcmap,
                        'srcmap-runtime': contract.srcmapRuntime,
                    }
                })

                output.sourceList = Object.keys(output.sources);
                delete output.sources;

                fs.writeFileSync(path.join(this.opts.outputSolDir, `combined.json`), JSON.stringify(output, null, 2));
            })
            .catch(e => {
                if (e instanceof BreakSignal) {
                    return;
                }
                console.error(e);
            });
    }

    /** 
     * removes any contracts from this.sources that have not changed since the last compile
    */
    removeUnchangedSources() {
        const unchanged = [];

        let currentVersion = (this.opts.solcVersion) ? this.opts.solcVersion + '.Emscripten.clang' : solc.version();
        if (currentVersion.startsWith('v')) currentVersion = currentVersion.slice(1);

        Object.keys(this.sources).forEach(f => {
            const contractName = f.split(path.sep).pop().replace('.sol', '');
            const buildFile = resolveBuildFile(this.opts, contractName);

            const prevMetadata = readMetadata(buildFile);

            const prevVersion = prevMetadata['_solcVersion'];

            // different versions, so we need to recompile
            if (prevVersion !== currentVersion) return;

            delete prevMetadata['_solcVersion'];
            const prevHashes = Object.assign({}, prevMetadata);

            // build file wasn't found, so we need to compile
            if (Object.keys(prevHashes).length === 0) return;

            // resolve all deps for this contract using regex b/c the solidity AST has
            // not been generated
            const contracts = this.resolveImportsFromFile(f);
            contracts.push(f);

            const contractHashes = contracts.reduce((val, c) => {
                val[c] = this.hashSource(c)
                return val;
            }, {});

            if (Object.keys(prevHashes).length !== Object.keys(contractHashes).length) return;

            let hasChanged = false;
            Object.keys(contractHashes).forEach(k => {
                if (contractHashes[k] !== prevHashes[k]) hasChanged = true;
            });

            if (!hasChanged) unchanged.push(f);
        });

        if (!this.opts.quiet) console.log('\n');
        unchanged.forEach(f => {
            if (!this.opts.quiet) console.log(`skipping ${f}... contract and dependencies unchanged`);
            delete this.sources[f];
        })
        if (!this.opts.quiet) console.log('\n');
    }

    /**
     * recursively resolves imports for a contract using regex
     * 
     * @param {string} sourceFile contract file to resolve imports for
     */
    resolveImportsFromFile(sourceFile) {
        let imports = [];

        const dirname = path.dirname(sourceFile);
        let prefix = '';
        if (dirname.startsWith('.')) {
            prefix = dirname.split(path.sep)[0] + path.sep;
        }

        const r = /^import[\s]*(['"])(.*)\1;/gm;
        const contract = this.sources[sourceFile] || this.importSources[sourceFile];

        // find all import statements
        const matches = (contract) ? contract.match(r) || [] : [];
        matches.forEach(i => {
            const r2 = /import[\s]*(['"])(.*)\1;/;
            let importFile = r2.exec(i)[2];

            // even though a leading './' isn't needed to resolve the file, _path needs to 
            // match how solidity will look for the file when calling the importCallback (resolvePath),
            // so we can return the already loaded file, as well as to sanity check the deps that we find
            // here w/ what solidity returns
            const _path = (importFile.startsWith('.')) ? prefix + path.join(dirname, importFile) : importFile;

            // loads the contract file if necessary
            if (!this.sources[_path] && !this.importSources[_path]) this.resolvePath(_path);

            imports = imports.concat([
                ...this.resolveImportsFromFile(_path),
                _path,
            ]);
        })

        return Array.from(new Set(imports));
    }

    /**
     * Generates the *.sol.js & *_all.sol files for the provided sourceFile, using the provided
     * compiler output.
     * 
     * @param {object} output solcjs compiler output
     * @param {string} sourceFile the contract to generate files for
     */
    generateFiles(output, sourceFile) {
        const contractFiles = this.resolveImports(output.sources, sourceFile);
        contractFiles.push(sourceFile);

        const contracts = Object.keys(output.contracts);

        // generate js file
        let js = '/* This is an autogenerated file. DO NOT EDIT MANUALLY */\n\n';

        contractFiles.forEach(f => {
            contracts.filter(c => c.startsWith(f))
                .forEach(c => {
                    const contractName = c.split(':')[1];
                    const abi = output.contracts[c].interface;
                    const byteCode = output.contracts[c].bytecode;
                    const runtimeByteCode = output.contracts[c].runtimeBytecode;
                    js += `exports.${contractName}Abi = ${abi}\n`;
                    js += `exports.${contractName}ByteCode = "0x${byteCode}"\n`;
                    js += `exports.${contractName}RuntimeByteCode = "0x${runtimeByteCode}"\n`;
                })
            js += `exports['_${f}_sha256'] = "${this.hashSource(f)}"\n`;
        });
        js += `exports._solcVersion = "${this.solc.version()}"\n`;

        const contractName = sourceFile.split(path.sep).pop().replace('.sol', '');
        fs.writeFileSync(resolveBuildFile(this.opts, contractName), js);

        // generate _all.sol file
        const r = /^import *"(.*)";/gm;

        let sol = '';
        contractFiles.forEach(c => {
            const contract = this.sources[c] || this.importSources[c];
            sol += `\n\n///File: ${c}\n${contract.replace(r, '')}`;
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

        ast.children
            .filter(c => c.name === 'ImportDirective')
            .forEach(i => {
                const { absolutePath } = i.attributes;
                imports = imports.concat([
                    ...this.resolveImports(sources, absolutePath),
                    absolutePath
                ]);
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

                if (isDep)
                    this.importSources[sourceFile] = this.applyConstants(_srcCode);
                else
                    this.sources[sourceFile] = this.applyConstants(_srcCode);
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
        if (isDep)
            this.importSources[sourceFile] = this.applyConstants(_srcCode);
        else
            this.sources[sourceFile] = this.applyConstants(_srcCode);
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
                this.importSources[_path] = this.importSources[f];
                delete this.sources[f];
            }
            return { contents: this.importSources[_path] };
        }

        if (fs.existsSync(_path)) return load(_path);

        let contractImportFile = path.join(this.baseDir, 'contracts', _path);
        if (fs.existsSync(contractImportFile)) return load(contractImportFile);

        let srcImportFile = path.join(this.baseDir, 'src', _path);
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

        return { error: `Looked in dir: ${_path}, contracts: ${contractImportFile}, src: ${srcImportFile}, npm: ${npmImportFile}, and libs` };
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
        if (this.opts.verbose) console.log('\ncollecting lib contracts using glob pattern ->', pattern, '\n');

        const libContracts = glob.sync(pattern);
        this.libs = {};
        libContracts.forEach(c => {
            const s = c.split(path.sep).slice(-3);
            const contract = (s[2] === 'index.sol') ? s[0] : path.join(s[0], s[2]);
            // libs are git submodules, so the same submodule may be included multiple times
            // we only keep the contract w/ the shortest path
            if (!this.libs[contract] ||
                c.split(path.sep).length < this.libs[contract].split(path.sep).length) {
                this.libs[contract] = c;
            }
        });

        if (this.opts.verbose) {
            Object.keys(this.libs).forEach(l => {
                console.log(`mapped ${l} -> ${this.libs[l]}`);
            });
            console.log('\n');
        }
    }

    applyConstants(src) {
        let srcOut = src;

        Object.keys(this.opts).forEach(param => {
            const value = this.opts[param];

            const rule = new RegExp(`constant ${param} = (.*);`, 'gm');
            const replacedText = `constant ${param} = ${value};`;

            srcOut = srcOut.replace(rule, replacedText);
        })

        return srcOut;
    }

    setSolidityVersion() {
        if (!this.opts.solcVersion) return Promise.resolve();

        const v = (this.opts.solcVersion.startsWith('v')) ? this.opts.solcVersion.slice(1) : this.opts.solcVersion;
        if (solc.version().startsWith(v)) return;

        if (!this.opts.quiet) console.log('setting solc version', this.opts.solcVersion);

        return new Promise((resolve, reject) => {
            solc.loadRemoteVersion(this.opts.solcVersion, (err, _solc) => {
                if (err) return reject(err);
                this.solc = _solc;
                resolve();
            })
        })
    }

    hashSource(f) {
        if (this.sourceHashes[f]) return this.sourceHashes[f];

        const source = this.sources[f] || this.importSources[f];

        const hash = crypto
            .createHash('sha256')
            .update(source, 'utf8')
            .digest('hex');

        this.sourceHashes[f] = hash;
        return hash;
    };

}

module.exports = Solcpiler;
