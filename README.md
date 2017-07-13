# SOLCPILER

Wraper to the solidity compiler.

This command line tool, generates a regular Javascript module file. You can use this file from another module in your project to access the ABI or the ByteCode of the compiler.

This tool also generates a monolitic text file with all the code of the `included` files. This file is very convenient to verify the code.

This module will check the hash of the source and the current solidity version to see if it is necessary to recompile the source. This saves a lot of time in the development process.


## Command Line

```bash
Options:
  --config-file, -c  Config file
  --output-js-dir    Output directory where js files will be copied. Default: ./build
  --output-sol-dir   Output directory where solidity files concatenated without includes will be copied. Default: ./build
  --solc-version     Solidity version. Example: v0.4.12+commit.194ff033
  --input, -i        Input files that can be compiled. Default: ./contracts/*.sol
  --createdir        Create directory if not exist. Default: true. Use --no-createdir to not create a directory
  --help             Show help
```

You can use a config file to specify options.
