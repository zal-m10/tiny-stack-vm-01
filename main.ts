// Faithful interpreter of make.fun's tiny stack ISA (version 1).
// Reads every $MAKEFUN_INPUT_DIR/<id>/{program,input}.bin and writes
// $MAKEFUN_OUTPUT_DIR/<id>/{stdout.bin,exit.txt}. Deterministic; the whole
// set runs in well under 60 s. See ISA.md in the kit for the rules.
import {mkdirSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR || '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR || '/output';
const text = new TextEncoder();

// Opcode metadata: [immediate bytes, values popped, values pushed].
// null means the byte names no opcode (trap 5). The two small tables are
// built once here, not on every executed step (up to 1,000,000 per instance).
const SMALL = [[0, 0, 0], [1, 0, 1], [4, 0, 1], [0, 1, 0], [0, 1, 2], [0, 2, 2], [0, 2, 3], [0, 3, 3]];
const JUMPS = [[2, 0, 0], [2, 1, 0], [2, 1, 0], [2, 0, 0], [0, 0, 0]];
function meta(op) {
  if (op < 8) return SMALL[op];
  if (op >= 16 && op <= 34) return op === 23 || op === 27 ? [0, 1, 1] : [0, 2, 1];
  if (op >= 48 && op <= 52) return JUMPS[op - 48];
  if (op === 64) return [0, 1, 1];
  if (op === 65) return [0, 2, 0];
  if (op === 80 || op === 81) return [0, 1, 0];
  if (op === 82) return [0, 0, 1];
  if (op === 83) return [0, 1, 0];
  return null;
}

// Runs one program on its input. Returns {o: bytes written, e: exit code}.
function run(prog, input) {
  const n = prog.length;
  const S = new Int32Array(256); // data stack
  const C = new Int32Array(64); // call stack
  const M = new Int32Array(256); // memory
  const out = new Uint8Array(65536);
  let sp = 0, cp = 0, ol = 0, ip = 0, pc = 0, steps = 0;
  const done = (exit) => ({o: out.slice(0, ol), e: exit});
  for (;;) {
    if (steps === 1000000) return done(10); // step limit
    if (pc < 0 || pc >= n) return done(9); // pc outside the program
    const m = meta(prog[pc]);
    if (!m) return done(5); // unknown opcode
    const [imm, pops, pushes] = m;
    if (pc + imm >= n) return done(9); // immediate cut off by the end
    steps++;
    if (sp < pops) return done(2); // stack underflow
    if (sp - pops + pushes > 256) return done(3); // stack overflow
    const p = pc, op = prog[p];
    pc = p + 1 + imm; // address of the next instruction
    // Two-operand arithmetic and logic (0x10-0x22 except unary NEG/NOT).
    if (op >= 16 && op <= 34 && op !== 23 && op !== 27) {
      const b = S[sp - 1], a = S[sp - 2];
      let r;
      switch (op) {
        case 16: r = (a + b) | 0; break; // ADD, wraps
        case 17: r = (a - b) | 0; break; // SUB, wraps
        case 18: r = Math.imul(a, b); break; // MUL, low 32 bits of the exact product
        case 19: // DIV, truncates toward zero
          if (!b) return done(4);
          r = a === -2147483648 && b === -1 ? a : (a / b) | 0;
          break;
        case 20: // MOD, sign of a
          if (!b) return done(4);
          r = b === -1 ? 0 : a % b | 0;
          break;
        case 21: // DIVU, unsigned
          if (!b) return done(4);
          r = Math.floor((a >>> 0) / (b >>> 0)) | 0;
          break;
        case 22: // MODU, unsigned
          if (!b) return done(4);
          r = (a >>> 0) % (b >>> 0) | 0;
          break;
        case 24: r = a & b; break; // AND
        case 25: r = a | b; break; // OR
        case 26: r = a ^ b; break; // XOR
        case 28: r = a << (b & 31); break; // SHL
        case 29: r = a >> (b & 31); break; // SHR, arithmetic
        case 30: r = (a >>> (b & 31)) | 0; break; // SHRU, logical
        case 32: r = a === b ? 1 : 0; break; // EQ
        case 33: r = a < b ? 1 : 0; break; // LT, signed
        case 34: r = (a >>> 0) < (b >>> 0) ? 1 : 0; break; // LTU, unsigned
      }
      sp -= 2;
      S[sp++] = r;
      continue;
    }
    switch (op) {
      case 0: return done(0); // HALT
      case 1: S[sp++] = (prog[p + 1] << 24) >> 24; break; // PUSH8, sign-extended
      case 2: S[sp++] = prog[p + 1] | prog[p + 2] << 8 | prog[p + 3] << 16 | prog[p + 4] << 24; break; // PUSH32
      case 3: sp--; break; // POP
      case 4: S[sp] = S[sp - 1]; sp++; break; // DUP
      case 5: { const t = S[sp - 1]; S[sp - 1] = S[sp - 2]; S[sp - 2] = t; break; } // SWAP
      case 6: S[sp] = S[sp - 2]; sp++; break; // OVER
      case 7: { const a = S[sp - 3]; S[sp - 3] = S[sp - 2]; S[sp - 2] = S[sp - 1]; S[sp - 1] = a; break; } // ROT
      case 23: S[sp - 1] = -S[sp - 1] | 0; break; // NEG, wraps at -2147483648
      case 27: S[sp - 1] = ~S[sp - 1]; break; // NOT
      case 48: case 49: case 50: { // JMP, JZ, JNZ
        const rel = ((prog[p + 1] | prog[p + 2] << 8) << 16) >> 16;
        if (op === 48) { pc += rel; break; }
        const v = S[--sp];
        if ((op === 49 && v === 0) || (op === 50 && v !== 0)) pc += rel;
        break;
      }
      case 51: // CALL
        if (cp === 64) return done(7);
        C[cp++] = pc;
        pc = prog[p + 1] | prog[p + 2] << 8;
        break;
      case 52: // RET
        if (cp === 0) return done(8);
        pc = C[--cp];
        break;
      case 64: { // LOAD
        const a = S[sp - 1];
        if (a < 0 || a >= 256) return done(6);
        S[sp - 1] = M[a];
        break;
      }
      case 65: { // STORE
        const a = S[sp - 1], v = S[sp - 2];
        if (a < 0 || a >= 256) return done(6);
        sp -= 2;
        M[a] = v;
        break;
      }
      case 80: { // PRINT, decimal ASCII
        const t = text.encode(String(S[sp - 1]));
        if (ol + t.length > 65536) return done(11);
        sp--;
        out.set(t, ol);
        ol += t.length;
        break;
      }
      case 81: // PUTC, one byte
        if (ol + 1 > 65536) return done(11);
        out[ol++] = S[--sp] & 255;
        break;
      case 82: S[sp++] = ip < input.length ? input[ip++] : -1; break; // IN, -1 after EOF
      case 83: return done(S[--sp] & 255); // EXIT, low byte of the code
    }
  }
}

// Answer every instance in the input directory.
for (const id of readdirSync(INPUT_DIR).sort()) {
  const prog = readFileSync(join(INPUT_DIR, id, 'program.bin'));
  const input = readFileSync(join(INPUT_DIR, id, 'input.bin'));
  const {o, e} = run(prog, input);
  const dir = join(OUTPUT_DIR, id);
  mkdirSync(dir, {recursive: true});
  writeFileSync(join(dir, 'stdout.bin'), o);
  writeFileSync(join(dir, 'exit.txt'), String(e) + '\n');
}
