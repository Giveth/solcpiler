#!/usr/bin/env node

const api = require('./api.js');

const yargs = require('yargs')
  .usage('Usage: $0 [options]')
  .option('config-file', {
    alias: 'c',
    describe: 'Config file',
    type: 'string',
  })
  .option('output-js-dir', {
    describe: 'Output directory where js files will be copied. Default: ./build',
    type: 'string',
  })
  .option('output-sol-dir', {
    describe: 'Output directory where solidity files concatenated without includes will be copied. Default: ./build',
    type: 'string',
  })
  .option('solc-version', {
    describe: 'Solidity version. Example: v0.4.12+commit.194ff033',
    type: 'string',
  })
  .option('input', {
    alias: 'i',
    describe: 'Input files that can be compiled. Default: ./contracts/*.sol',
    type: 'string',
  })
  .option('createdir', {
    describe: 'Create directory if not exist. Default: true. Use --no-createdir to not create a directory',
    type: 'boolean',
  })
  .help()
  .argv

/*
if (yargs.help === true) {
  yargs.showHelp();
  process.exit(0);
}
*/

const optsCommandLine = {};

if (yargs.outputJsDir) optsCommandLine.outputJsDir = yargs.outputJsDir;
if (yargs.outputSolDir) optsCommandLine.outputSolDir = yargs.outputSolDir;
if (yargs.solcVersion) optsCommandLine.solcVersion = yargs.solcVersion;
if (yargs.input) optsCommandLine.input = yargs.input;
if (yargs.createdir) optsCommandLine.createdir = yargs.createdir;

const configFile = yargs.configFile || 'solcpiler.json';

api.runFromConfigFile(configFile, optsCommandLine, (err) => {
  if (err) {
    /*eslint no-console: "allow"*/
    console.error("ERROR:", err);
  }
});

