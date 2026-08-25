#!/usr/bin/env node
/**
 * Utilidad de mantenimiento de PROJECT_DEVLOG.md usada por el bucle de desarrollo.
 *
 *   node scripts/devlog.mjs done F0.1 F0.2 ...     -> marca [x]
 *   node scripts/devlog.mjs wip  F1.4              -> marca [~]
 *   node scripts/devlog.mjs todo F1.4              -> marca [ ]
 *   node scripts/devlog.mjs status                 -> lee la línea de estado global
 *   node scripts/devlog.mjs status "texto"         -> la actualiza
 *   node scripts/devlog.mjs report                 -> resumen de progreso por fase
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Lee el devlog normalizando los finales de línea.
 *
 * Un editor de Windows puede dejar el archivo en CRLF. Entonces cada línea termina con un retorno
 * de carro que las expresiones de este script no esperan, y el informe sale a cero sin decir por
 * qué.
 */
function readDoc(path) {
  return readFileSync(path, 'utf8').replace(new RegExp(String.raw`\r\n`, 'g'), '\n');
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Documento sobre el que se trabaja.
 *
 * `DEVLOG_FILE` existe para las pruebas: ejercitar este script contra el devlog de verdad sería
 * escribir en la bitácora del proyecto cada vez que se ejecuta la suite.
 */
const file = process.env['DEVLOG_FILE'] ?? join(root, 'PROJECT_DEVLOG.md');

const MARKS = { done: '[x]', wip: '[~]', todo: '[ ]' };

function setMarks(ids, mark) {
  let doc = readDoc(file);
  const missing = [];
  for (const id of ids) {
    const lines = doc.split('\n');
    let found = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Coincide con: "- [x] F1.10 texto"  (id seguido de espacio, evita que F1.1 pise a F1.10)
      const m = /^- \[[x~ ]\] (\S+) /.exec(line);
      if (m && m[1] === id) {
        lines[i] = line.replace(/^- \[[x~ ]\]/, `- ${mark}`);
        found = true;
        break;
      }
    }
    if (found) doc = lines.join('\n');
    else missing.push(id);
  }
  writeFileSync(file, doc, 'utf8');
  if (missing.length) {
    console.error(`[devlog] AVISO: ids no encontrados -> ${missing.join(', ')}`);
    process.exitCode = 1;
  }
  console.log(`[devlog] ${ids.length - missing.length}/${ids.length} tareas marcadas ${mark}`);
}

const STATUS_LINE = /^- \*\*Estado global:\*\*[ \t]*(.*)$/m;

/** Lee la línea de estado global. Cadena vacía si está en blanco; `null` si no existe la línea. */
function readStatus() {
  return readDoc(file).match(STATUS_LINE)?.[1]?.trim() ?? null;
}

/**
 * Escribe la línea de estado global.
 *
 * **Con texto vacío no escribe nada**, y eso arregla un fallo que se comió el campo en silencio:
 * `devlog.mjs status`, sin argumentos, llamaba aquí con la cadena vacía y dejaba el encabezado del
 * devlog anunciando un estado que no ponía nada. Los comandos `done`, `wip` y `todo` ya se
 * protegían de la lista vacía; éste no. Sin argumentos ahora **lee**, que además es lo que
 * cualquiera espera de algo llamado `status`.
 */
function setStatus(text) {
  const trimmed = text.trim();

  if (trimmed === '') {
    const current = readStatus();
    if (current === null) {
      console.error('[devlog] no hay línea de estado global en el documento');
      process.exitCode = 1;
      return;
    }

    console.log(`[devlog] estado global: ${current === '' ? '(vacío)' : current}`);
    console.log('[devlog] para cambiarlo: devlog.mjs status "texto"');
    return;
  }

  const doc = readDoc(file);
  if (!STATUS_LINE.test(doc)) {
    console.error('[devlog] no hay línea de estado global que actualizar');
    process.exitCode = 1;
    return;
  }

  writeFileSync(file, doc.replace(STATUS_LINE, `- **Estado global:** ${trimmed}`), 'utf8');
  console.log(`[devlog] estado global -> ${trimmed}`);
}

function report() {
  const doc = readDoc(file);
  const lines = doc.split('\n');
  let phase = null;
  const phases = [];
  for (const line of lines) {
    const p = /^### (Fase \d+ .*)$/.exec(line);
    if (p) {
      phase = { name: p[1], done: 0, wip: 0, todo: 0 };
      phases.push(phase);
      continue;
    }
    if (/^## /.test(line) && !/^### /.test(line)) phase = null;
    const t = /^- \[([x~ ])\] /.exec(line);
    if (t && phase) {
      if (t[1] === 'x') phase.done++;
      else if (t[1] === '~') phase.wip++;
      else phase.todo++;
    }
  }
  let totalDone = 0;
  let total = 0;
  for (const p of phases) {
    const n = p.done + p.wip + p.todo;
    totalDone += p.done;
    total += n;
    const pct = n ? Math.round((p.done / n) * 100) : 0;
    const bar = '#'.repeat(Math.round(pct / 5)).padEnd(20, '.');
    console.log(`${bar} ${String(pct).padStart(3)}%  ${p.done}/${n}  ${p.name}`);
  }
  const pct = total ? Math.round((totalDone / total) * 100) : 0;
  console.log(`\n[devlog] TOTAL: ${totalDone}/${total} (${pct}%)`);
}

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case 'done':
  case 'wip':
  case 'todo':
    if (!rest.length) {
      console.error('[devlog] faltan ids');
      process.exit(1);
    }
    setMarks(rest, MARKS[cmd]);
    break;
  case 'status':
    setStatus(rest.join(' '));
    break;
  case 'report':
    report();
    break;
  default:
    console.error('[devlog] uso: devlog.mjs <done|wip|todo|status|report> [args]');
    process.exit(1);
}
