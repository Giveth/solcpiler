#!/usr/bin/env node

const yargs = require('yargs')
  .usage('Usage: $0 [options]')
  .option('config-file', {
    alias: 'c',
    describe: 'JSON config file',
    type: 'string',
    default: 'solcpiler.json'
  })
  .option('output-js-dir', {
    describe: 'Output directory for JS files',
    default: './build',
    type: 'string',
  })
  .option('output-sol-dir', {
    describe: 'Output directory for processed Solidity files (without includes)',
    default: './build',
    type: 'string',
  })
  .option('solc-version', {
    describe: 'Solidity version\nExample: v0.4.12+commit.194ff033',
    type: 'string',
  })
  .option('input', {
    alias: 'i',
    describe: 'Input files to compile',
    // default: './contracts/*.sol',
    type: 'string',
  })
  .option('createdir', {
    alias: 'd',
    describe: 'Create directories if needed',
    default: true,
    type: 'boolean',
  })
  .help()
  .argv;

const api = require('./api.js');

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
