#!/usr/bin/env node

const api = require('./api.js');

const yargs = require('yargs')
  .usage('Usage: $0 [options]')
  .option('config-file', {
    alias: 'c',
    describe: 'Config file',
    type: 'string',
  })
  .option('output-sol-dir', {
    describe: 'Output directory where solidity files concatenated without includes will be copied. Default: ./build',
    type: 'string',
  })
  .option('output-artifacts-dir', {
    describe: 'Output directory where artifact files will be generated.',
    type: 'string',
  })
  .option('solc-version', {
    describe: 'Solidity version. Example: v0.4.12+commit.194ff033',
    type: 'string',
  })
  .option('input', {
    alias: 'i',
    describe: 'Input files that can be compiled. Default: ./contracts/*.sol',
    type: 'array',
  })
  .option('createdir', {
    describe: 'Create directory if not exist. Default: true. Use --no-createdir to not create a directory',
    type: 'boolean',
  })
  .option('insert-file-names', {
    describe: 'Insert original file names in the resulting concatenate files. ' +
      'Use \'imports\' to only insert name in files with imports. Default: all',
    choices: ['all', 'none', 'imports'],
    default: 'all'
  })
  .option('quiet', {
    alias: 'q',
    describe: 'Silence output and compiler warnings. Default: false',
    type: 'boolean',
  })
  .option('verbose', {
    alias: 'v',
    describe: 'verbose output. Default: false',
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

const optsCommandLine = {insertFileNames: yargs.insertFileNames};

if (yargs.outputJsDir) optsCommandLine.outputJsDir = yargs.outputJsDir;
if (yargs.outputSolDir) optsCommandLine.outputSolDir = yargs.outputSolDir;
if (yargs.outputArtifactsDir) optsCommandLine.outputArtifactsDir = yargs.outputArtifactsDir;
if (yargs.solcVersion) optsCommandLine.solcVersion = yargs.solcVersion;
if (yargs.input) optsCommandLine.input = yargs.input;
if (yargs.createdir) optsCommandLine.createdir = yargs.createdir;
if (yargs.quiet) optsCommandLine.quiet = yargs.quiet;
if (yargs.verbose) optsCommandLine.verbose = yargs.verbose;

const configFile = yargs.configFile || 'solcpiler.json';

api.runFromConfigFile(configFile, optsCommandLine, (err) => {
  if (err) {
    /*eslint no-console: "allow"*/
    console.error("ERROR:", err);
  }
});
