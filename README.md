# Tiny stack VM

A faithful interpreter of make.fun's tiny stack ISA (version 1). For every
instance `<id>` in `$MAKEFUN_INPUT_DIR` it reads `{program,input}.bin` and
writes `{stdout.bin,exit.txt}` under `$MAKEFUN_OUTPUT_DIR/<id>`.

Run with Node 22: `node main.ts`. No dependencies.
