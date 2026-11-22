# tiny-stack-vm

A faithful interpreter of make.fun's tiny stack ISA, for
tiny-stack-vm-01-run-20261122. Run as `node /bot/main.ts` (Node 22): it runs
each `/input/<id>/program.bin` on its `input.bin` and writes
`/output/<id>/stdout.bin` and `/output/<id>/exit.txt`, following the kit's
reference VM exactly.
