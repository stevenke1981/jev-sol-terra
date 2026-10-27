import fs from 'node:fs';
import path from 'node:path';
import { MODEL_KEYS } from './config.js';

const C = process.stdout.isTTY && !process.env.NO_COLOR
  ? { blue: '\x1b[34m', green: '\x1b[32m', dim: '\x1b[2m', bold: '\x1b[1m', reset: '\x1b[0m' }
  : { blue: '', green: '', dim: '', bold: '', reset: '' };

// In-memory decisions carry the model key in `model`; log records keep the upstream id
// in `model` and the key in `modelKey`. A record without `modelKey` is an effort-only row.
function modelKeyOf(d) {
  if ('modelKey' in d) return d.modelKey;
  return MODEL_KEYS.includes(d.model) ? d.model : null;
}

const levelLabel = (model, effort) => (effort ? `${model.toUpperCase()}·${effort.toUpperCase()}` : model.toUpperCase());

// "LOW → MEDIUM", or just the effort when nothing changed.
function effortLevels(d) {
  return d.from && d.from !== d.effort
    ? `${d.from.toUpperCase()} → ${d.effort.toUpperCase()}`
    : d.effort.toUpperCase();
}

// "TERRA·LOW → SOL·XHIGH"; a model-only decision (effort left alone) shows just the model.
function modelLevels(d, modelKey) {
  const to = levelLabel(modelKey, d.effort);
  const changed = Boolean(d.fromModel) || Boolean(d.from && d.from !== d.effort);
  if (!changed) return to;
  return `${levelLabel(d.fromModel ?? modelKey, d.from ?? d.effort)} → ${to}`;
}

// Mirrors the in-task status line: "Jev  LOW → MEDIUM  ✓ APPLIED".
export function formatDecision(d) {
  const modelKey = modelKeyOf(d);
  const levels = modelKey ? modelLevels(d, modelKey) : effortLevels(d);
  const reasons = [...(d.effort ? d.reasons : []), ...(d.modelReasons ?? [])];
  const gens = Math.max(1, d.hold);
  const detail = [`Step ${d.step}`, ...(d.effort ? [`next ${gens} generation(s)`] : []), `${d.ms} ms`, reasons.join('; ')];
  return `${C.blue}Jev${C.reset}  ${C.bold}${levels}${C.reset}  ${C.green}✓ APPLIED${C.reset}\n`
    + `${C.dim}     ${detail.join(' · ')}${C.reset}`;
}

export function createDecisionLog(config) {
  fs.mkdirSync(path.dirname(config.logFile), { recursive: true });
  return {
    write(record) {
      fs.appendFile(config.logFile, `${JSON.stringify(record)}\n`, (err) => {
        if (err) process.stderr.write(`jev: cannot write ${config.logFile}: ${err.message}\n`);
      });
    },
  };
}

export function readDecisions(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

// Responses reports `output_tokens_details`, Chat Completions `completion_tokens_details`.
export function usageTokens(usage) {
  return {
    reasoning: usage?.output_tokens_details?.reasoning_tokens ?? usage?.completion_tokens_details?.reasoning_tokens ?? null,
    output: usage?.output_tokens ?? usage?.completion_tokens ?? null,
  };
}
