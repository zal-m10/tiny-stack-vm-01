// tiny-stack-vm: a faithful interpreter of make.fun's tiny stack ISA (ISA.md).
// Run as `node /bot/main.ts` (Node 22): reads $MAKEFUN_INPUT_DIR/<id>/program.bin
// and input.bin, writes $MAKEFUN_OUTPUT_DIR/<id>/stdout.bin and exit.txt. Each step
// checks, in order: step limit (10), pc bounds (9), opcode (5), immediate
// fitting (9), stack pops/pushes (2/3), then the instruction's own traps.
// A trap ends the program at once with the trap's code, keeping earlier output.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const T_UNDERFLOW = 2, T_OVERFLOW = 3, T_DIV_ZERO = 4, T_BAD_OPCODE = 5;
const T_MEMORY = 6, T_CALL_DEPTH = 7, T_RET_EMPTY = 8, T_PC = 9;
const T_STEPS = 10, T_OUTPUT = 11;

// [byte, imm, pops, pushes] x38 (byte in decimal).
const OPS: number[] = [
  0, 0, 0, 0, 1, 1, 0, 1, 2, 4, 0, 1, 3, 0, 1, 0, 4, 0, 1, 2, 5, 0, 2, 2, 6, 0, 2, 3, 7, 0, 3, 3,
  16, 0, 2, 1, 17, 0, 2, 1, 18, 0, 2, 1, 19, 0, 2, 1, 20, 0, 2, 1, 21, 0, 2, 1, 22, 0, 2, 1, 23, 0, 1, 1,
  24, 0, 2, 1, 25, 0, 2, 1, 26, 0, 2, 1, 27, 0, 1, 1, 28, 0, 2, 1, 29, 0, 2, 1, 30, 0, 2, 1, 32, 0, 2, 1,
  33, 0, 2, 1, 34, 0, 2, 1, 48, 2, 0, 0, 49, 2, 1, 0, 50, 2, 1, 0, 51, 2, 0, 0, 52, 0, 0, 0, 64, 0, 1, 1,
  65, 0, 2, 0, 80, 0, 1, 0, 81, 0, 1, 0, 82, 0, 0, 1, 83, 0, 1, 0,
];

// Opcode -> [imm, pops, pushes].
const OP_BY_BYTE: ([number, number, number] | undefined)[] = new Array(256).fill(undefined);
for (let i = 0; i < OPS.length; i += 4) OP_BY_BYTE[OPS[i]] = [OPS[i + 1], OPS[i + 2], OPS[i + 3]];

const enc = new TextEncoder();

function run(program: Uint8Array, input: Uint8Array): { out: Uint8Array; exit: number } {
  const n = program.length;
  const D = new Int32Array(256);
  let sp = 0;
  const C = new Int32Array(64);
  let csp = 0;
  const M = new Int32Array(256);
  const out = new Uint8Array(65536);
  let olen = 0, inPos = 0, pc = 0, steps = 0;
  const done = (exit: number) => ({ out: out.slice(0, olen), exit });
  for (;;) {
    if (steps === 1e6) return done(T_STEPS);
    if (pc < 0 || pc >= n) return done(T_PC);
    const oc = program[pc];
    const op = OP_BY_BYTE[oc];
    if (op === undefined) return done(T_BAD_OPCODE);
    const [imm, pops, pushes] = op;
    if (pc + imm >= n) return done(T_PC);
    steps++;
    const next = pc + 1 + imm;
    if (sp < pops) return done(T_UNDERFLOW);
    if (sp - pops + pushes > 256) return done(T_OVERFLOW);
    pc = next;
    switch (oc) {
      case 0x00:
        return done(0);
      case 0x01:
        D[sp++] = (program[next - 1] << 24) >> 24;
        break;
      case 0x02:
        D[sp++] = program[next - 4] | (program[next - 3] << 8) | (program[next - 2] << 16) | (program[next - 1] << 24);
        break;
      case 0x03:
        sp--;
        break;
      case 0x04:
        D[sp] = D[sp - 1];
        sp++;
        break;
      case 0x05: {
        const t = D[sp - 1];
        D[sp - 1] = D[sp - 2];
        D[sp - 2] = t;
        break;
      }
      case 0x06:
        D[sp] = D[sp - 2];
        sp++;
        break;
      case 0x07: {
        const a = D[sp - 3];
        D[sp - 3] = D[sp - 2];
        D[sp - 2] = D[sp - 1];
        D[sp - 1] = a;
        break;
      }
      case 0x17:
        D[sp - 1] = -D[sp - 1] | 0;
        break;
      case 0x1b:
        D[sp - 1] = ~D[sp - 1];
        break;
      case 0x10: case 0x11: case 0x12: case 0x13: case 0x14: case 0x15:
      case 0x16: case 0x18: case 0x19: case 0x1a: case 0x1c: case 0x1d:
      case 0x1e: case 0x20: case 0x21: case 0x22: {
        const b = D[sp - 1];
        const a = D[sp - 2];
        let r: number;
        switch (oc) {
          case 0x10: r = (a + b) | 0; break;
          case 0x11: r = (a - b) | 0; break;
          case 0x12: r = Math.imul(a, b); break; // exact low 32 bits
          case 0x13:
            if (b === 0) return done(T_DIV_ZERO);
            r = a === -2147483648 && b === -1 ? a : (a / b) | 0;
            break;
          case 0x14:
            if (b === 0) return done(T_DIV_ZERO);
            r = b === -1 ? 0 : (a % b) | 0;
            break;
          case 0x15:
            if (b === 0) return done(T_DIV_ZERO);
            r = Math.floor((a >>> 0) / (b >>> 0)) | 0;
            break;
          case 0x16:
            if (b === 0) return done(T_DIV_ZERO);
            r = ((a >>> 0) % (b >>> 0)) | 0;
            break;
          case 0x18: r = a & b; break;
          case 0x19: r = a | b; break;
          case 0x1a: r = a ^ b; break;
          case 0x1c: r = a << (b & 31); break;
          case 0x1d: r = a >> (b & 31); break;
          case 0x1e: r = (a >>> (b & 31)) | 0; break;
          case 0x20: r = a === b ? 1 : 0; break;
          case 0x21: r = a < b ? 1 : 0; break;
          default: r = (a >>> 0) < (b >>> 0) ? 1 : 0; break;
        }
        sp -= 2;
        D[sp++] = r;
        break;
      }
      case 0x30: case 0x31: case 0x32: {
        const rel = ((program[next - 2] | (program[next - 1] << 8)) << 16) >> 16;
        let take = true;
        if (oc !== 0x30) {
          const v = D[--sp];
          take = oc === 0x31 ? v === 0 : v !== 0;
        }
        if (take) pc = next + rel;
        break;
      }
      case 0x33:
        if (csp === 64) return done(T_CALL_DEPTH);
        C[csp++] = next;
        pc = program[next - 2] | (program[next - 1] << 8);
        break;
      case 0x34:
        if (csp === 0) return done(T_RET_EMPTY);
        pc = C[--csp];
        break;
      case 0x40: {
        const addr = D[sp - 1];
        if (addr < 0 || addr >= 256) return done(T_MEMORY);
        D[sp - 1] = M[addr];
        break;
      }
      case 0x41: {
        const addr = D[sp - 1];
        const v = D[sp - 2];
        if (addr < 0 || addr >= 256) return done(T_MEMORY);
        sp -= 2;
        M[addr] = v;
        break;
      }
      case 0x50: {
        const bytes = enc.encode(String(D[sp - 1]));
        if (olen + bytes.length > 65536) return done(T_OUTPUT);
        sp--;
        out.set(bytes, olen);
        olen += bytes.length;
        break;
      }
      case 0x51:
        if (olen + 1 > 65536) return done(T_OUTPUT);
        out[olen++] = D[--sp] & 255;
        break;
      case 0x52:
        D[sp++] = inPos < input.length ? input[inPos++] : -1;
        break;
      case 0x53:
        return done(D[--sp] & 255);
    }
  }
}

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
for (const id of readdirSync(I).sort()) {
  const r = run(new Uint8Array(readFileSync(join(I, id, 'program.bin'))), new Uint8Array(readFileSync(join(I, id, 'input.bin'))));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'stdout.bin'), r.out);
  writeFileSync(join(O, id, 'exit.txt'), `${r.exit}\n`);
}
