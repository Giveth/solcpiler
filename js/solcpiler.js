const path = require('path');
const appRoot = require('app-root-path');
const fs = require('fs');
const crypto = require('crypto');
const solc = require('solc');
const async = require('async');
const _ = require('lodash');


const hashFile = (f) => {
  const str = fs.readFileSync(f, 'utf8');

  return crypto
    .createHash('sha256')
    .update(str, 'utf8')
    .digest('hex');
};

class Solcpiler {
  loadSol(file, _imported, _cb) {
    const self = this;
    let cb;
    let imported;
    if (typeof _imported === 'function') {
      cb = _imported;
      imported = {};
    } else {
      imported = _imported;
      cb = _cb;
    }

    let src = '';
    const h = hashFile(file);

    //    var file = path.resolve(path.join(__dirname, ".."), filename);
    if (imported[h]) {
      return cb(null, src);
    }

    imported[h] = true;
    fs.readFile(file, 'utf8', (err, _srcCode) => {
      let srcCode = _srcCode;
      if (err) return cb(err);

      const r = /^import[\s]*(['"])(.*)\1;/gm;

      const arr = srcCode.match(r);

      srcCode = srcCode.replace(r, '');

      async.eachSeries(arr, (l, cb2) => {
        const r2 = /import[\s]*(['"])(.*)\1;/;
        let importfile = r2.exec(l)[2];

        importfile = Solcpiler.resolveFile(path.dirname(path.resolve(file)), importfile);

        self.loadSol(importfile, imported, (err2, importSrc) => {
          if (err2) return cb(err2);
          src += importSrc;
          cb2();
          return null;
        });
      }, (err2) => {
        if (err2) return cb(err2);
        src += `\n//File: ${path.relative('.', file)}\n`;
        src += srcCode;
        cb(null, src);
        return null;
      });
      return null;
    });
    return null;
  }

  static applyConstants(src, opts, cb) {
    let srcOut = src;

    _.each(opts, (value, param) => {
      const rule = new RegExp(`constant ${param} = (.*);`, 'gm');
      const replacedText = `constant ${param} = ${value};`;

      srcOut = srcOut.replace(rule, replacedText);
    });

    async.setImmediate(() => {
      cb(null, srcOut);
    });
  }

  static resolveFile(baseDir, file) {
    const importFile = path.join(baseDir, file);
    if (fs.existsSync(importFile)) return importFile;

    let npmImportFile;
    if (require.resolve.path) {
      npmImportFile = require.resolve(file, { paths: [process.cwd()] });
      if (fs.existsSync(npmImportFile)) return npmImportFile;
    } else {
      npmImportFile = path.join(process.cwd(), 'node_modules', file);
      if (fs.existsSync(npmImportFile)) return npmImportFile;
    }

    const libFile = path.join(baseDir, '..', 'lib', path.dirname(file), 'src', path.basename(file));
    if (fs.existsSync(libFile)) return libFile;

    console.log("File not found: Search places: ");
    console.log("direcr ",importFile);
    console.log("npm: ",npmImportFile);
    console.log("lib: ",libFile);

    return file;
  }

  static fixErrorLines(src, _errors) {
    const errors = _errors;
    const lines = src.split('\n');
    _.each(errors, (error, idx) => {
      const rErrPos = new RegExp(':([0-9]+):([0-9]+):');
      const errPos = rErrPos.exec(error);
      const lineNum = errPos ? parseInt(errPos[1], 10) - 1 : -1;
      let found = false;
      let offset = 1;
      const rFile = new RegExp('//File: (.*)', '');
      while ((!found) && (offset <= lineNum)) {
        const fileInfo = rFile.exec(lines[lineNum - offset]);
        if (fileInfo) {
          errors[idx] = error.replace(rErrPos, `${fileInfo[1]} :${offset}:${errPos[2]}`);
          found = true;
        } else {
          offset += 1;
        }
      }
    });
  }

  setSolidityVersion(version, cb) {
    if (version) {
      solc.loadRemoteVersion(version, (err, _solcV) => {
        if (err) return cb(err);
        this.useSolc = _solcV;
        cb();
        return null;
      });
    } else {
      this.useSolc = solc;
      async.setImmediate(cb);
    }
  }

  solCompile(src, cb) {
    const result = this.useSolc.compile(src, 1);
    if (Object.keys(result.contracts).length === 0) {
      Solcpiler.fixErrorLines(src, result.errors);
      return cb(result.errors);
    }
    async.setImmediate(() => {
      cb(null, result.contracts);
    });
    return null;
  }

  static readLastHash(destFile, cb) {
    fs.readFile(destFile, 'utf8', (err, data) => {
      if (err) {
        cb(null, null, null);
        return;
      }
      const h = /exports\._sha256 = "(.*)"/g.exec(data);
      if (!h || !h[1]) {
        cb(null, null, null);
        return;
      }
      const v = /exports\._solcVersion = "(.*)"/g.exec(data);
      if (!v || !v[1]) {
        cb(null, null, null);
        return;
      }
      cb(null, h[1], v[1]);
    });
  }

  static calcCurrentHash(src, cb) {
    const hash = crypto.createHash('sha256');

    hash.update(src);

    const r = hash.digest('hex');
    cb(null, `0x${r}`);
    return null;
  }

  compile(sourceFile, destFile, destSrcFile, _opts, _cb) {
    const self = this;
    let cb;
    let opts;
    if (typeof _opts !== 'object') {
      cb = _opts;
      opts = {};
    } else {
      cb = _cb;
      opts = _opts;
    }

    let compilationResult;
    let src;
    let lastHash;
    let currentHash;
    let lastSolcVersion;
    let currentSolcVersion;

    return async.series([
      (cb2) => {
        self.loadSol(sourceFile, (err, _src) => {
          if (err) return cb2(err);
          src = _src;
          return cb2();
        });
      },
      (cb2) => {
        Solcpiler.applyConstants(src, opts, (err, _src) => {
          if (err) return cb2(err);
          src = _src;
          return cb2();
        });
      },
      (cb2) => {
        self.setSolidityVersion(opts.solcVersion, (err) => {
          if (err) return cb2(err);
          return cb2();
        });
      },
      (cb2) => {
        Solcpiler.readLastHash(destFile, (err, hash, version) => {
          if (err) return cb2(err);
          lastHash = hash;
          lastSolcVersion = version;
          return cb2();
        });
      },
      (cb2) => {
        Solcpiler.calcCurrentHash(src, (err, hash) => {
          if (err) return cb2(err);
          currentHash = hash;
          currentSolcVersion = this.useSolc.version();
          return cb2();
        });
      },
      (cb2) => {
        // Shorcut if it's already compiled
        if ((lastHash === currentHash) &&
            (lastSolcVersion === currentSolcVersion)) {
          return cb2();
        }
        self.solCompile(src, (err, result) => {
          if (err) return cb2(err);
          compilationResult = result;
          return cb2();
        });
        return null;
      },
      (cb2) => {
        // Shorcut if it's already compiled
        if ((lastHash === currentHash) &&
            (lastSolcVersion === currentSolcVersion)) {
          return cb2();
        }
        let S = '';
        S += '/* This is an autogenerated file. DO NOT EDIT MANUALLY */\n\n';

//        console.log(destFile, JSON.stringify(Object.keys(compilationResult.keys)));

        _.each(compilationResult, (contract, _contractName) => {
          let contractName;
          if (_contractName[0] === ':') {
            contractName = _contractName.substr(1);
          } else {
            contractName = _contractName;
          }
          const abi = JSON.parse(contract.interface);
          const byteCode = contract.bytecode;
          const runtimeByteCode = contract.runtimeBytecode;
          S += `exports.${contractName}Abi = ${JSON.stringify(abi)}\n`;
          S += `exports.${contractName}ByteCode = "0x${byteCode}"\n`;
          S += `exports.${contractName}RuntimeByteCode = "0x${runtimeByteCode}"\n`;
        });
        S += `exports._solcVersion = "${self.useSolc.version()}"\n`;
        S += `exports._sha256 = "${currentHash}"\n`;

        fs.writeFile(destFile, S, cb2);
        return null;
      },
      (cb2) => {
        fs.writeFile(destSrcFile, src, cb2);
      },
    ], cb);
  }
}


const solcpiler = new Solcpiler();

module.exports = solcpiler;

