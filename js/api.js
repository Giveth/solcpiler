const path = require('path');
const async = require('async');
const glob = require('glob');
const fs = require('fs');
const solcpiler = require('./solcpiler.js');

const checkDirectoryExists = (dir, createdir, cb) => {
  fs.stat(dir, (err, stats) => {
    if (err) {
      if (createdir) {
        fs.mkdir(dir, cb);
      } else {
        cb(new Error(`${dir} does not exists`));
      }
    } else if (!stats.isDirectory()) {
      cb(new Error(`${dir} is not a directory`));
    } else {
      cb();
    }
  });
};

const compile = (opts, cb) => {
  glob(opts.input, {}, (err, files) => {
    if (err) {
      return;
    }
    async.eachSeries(files, (file, cb2) => {
      const fileName = path.basename(file, '.sol');
      solcpiler.compile(
        file,
        path.join(opts.outputJsDir, `${fileName}.sol.js`),
        path.join(opts.outputSolDir, `${fileName}_all.sol`),
        opts,
        cb2,
      );
    }, cb);
  });
};

const copyFile = (source, target, cb) => {
  let cbCalled = false;

  const done = (err) => {
    if (!cbCalled) {
      cb(err);
      cbCalled = true;
    }
  };

  const rd = fs.createReadStream(source);
  rd.on('error', (err) => {
    done(err);
  });
  const wr = fs.createWriteStream(target);
  wr.on('error', (err) => {
    done(err);
  });
  wr.on('close', () => {
    done();
  });
  rd.pipe(wr);
};

const run = (opts, cb) => {
  async.series([
    (cb2) => {
      checkDirectoryExists(opts.outputJsDir, opts.createdir, cb2);
    },
    (cb2) => {
      checkDirectoryExists(opts.outputSolDir, opts.createdir, cb2);
    },
    (cb2) => {
      compile(opts, cb2);
    },
    (cb2) => {
      copyFile(path.join(__dirname, 'contracts.js'), path.join(opts.outputJsDir, 'contracts.js'), cb2);
    },
  ], cb);
};

const readConfigFile = (filename, cb) => {
  if (!filename) {
    cb(null, {});
    return;
  }
  fs.readFile(filename, 'utf8', (err, data) => {
    if (err) {
      cb(null, {});
      return;
    }
    try {
      cb(null, JSON.parse(data));
    } catch (err2) {
      cb(new Error('Invalid config file'));
    }
  });
};

const optsDefault = {
  outputJsDir: 'build',
  outputSolDir: 'build',
  // solcVersion: "v0.4.12+commit.194ff033",
  input: './*.sol',
  createdir: true,
};

if (fs.existsSync('./contracts')) {
  optsDefault.input = './contracts/*.sol';
} else if (fs.existsSync('./src')) {
  optsDefault.input = './src/*.sol';
}

const runFromConfigFile = (configFile, overloadOpts, cb) => {
  readConfigFile(configFile, (err, optsFile) => {
    if (err) return cb();
    const opts = Object.assign(optsDefault, optsFile, overloadOpts);
    // console.log(JSON.stringify(opts, null, 2));
    run(opts, cb);
    return null;
  });
};

module.exports.run = run;
module.exports.runFromConfigFile = runFromConfigFile;
