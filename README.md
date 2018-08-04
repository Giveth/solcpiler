# SOLCPILER

Wraper to the solidity compiler.

This command line tool, generates a regular Javascript module file. You can use this file from another module in your project to access the ABI or the ByteCode of the compiler.

This tool also generates a monolitic text file with all the code of the `included` files. This file is very convenient to verify the code.

This module will check the hash of the source and the current solidity version to see if it is necessary to recompile the source. This saves a lot of time in the development process.


## Command Line

```bash
Options:
  --config-file, -c       Config file                                   [string]
  --output-sol-dir        Output directory where solidity files concatenated
                          without includes will be copied. Default: ./build
                                                                        [string]
  --output-artifacts-dir  Output directory where artifact files will be
                          generated.                                    [string]
  --solc-version          Solidity version. Example: v0.4.12+commit.194ff033
                                                                        [string]
  --input, -i             Input files that can be compiled. Default:
                          ./contracts/*.sol                              [array]
  --createdir             Create directory if not exist. Default: true. Use
                          --no-createdir to not create a directory     [boolean]
  --insert-file-names     Insert original file names in the resulting
                          concatenate files. Use 'imports' to only insert name
                          in files with imports. Default: all
                            [choices: "all", "none", "imports"] [default: "all"]
  --quiet, -q             Silence output and compiler warnings. Default: false
                                                                       [boolean]
  --verbose, -v           verbose output. Default: false               [boolean]
  --help                  Show help                                    [boolean]
```

You can use a config file to specify options.
