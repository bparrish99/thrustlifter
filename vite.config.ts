import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

const LEVEL_DIR = resolve(__dirname, 'src/levels');
const ORDER_PATH = resolve(LEVEL_DIR, 'order.json');
const validName = (f: unknown): f is string => typeof f === 'string' && /^[a-z0-9][a-z0-9-]*\.json$/.test(f) && f !== 'order.json';

/** Read a JSON request body, run `fn` on it, reply with its result (or the error). */
function jsonRoute(fn: (body: any) => object) {
  return (req: any, res: any) => {
    if (req.method !== 'POST') {
      res.statusCode = 405;
      return res.end();
    }
    let body = '';
    req.on('data', (c: string) => (body += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      try {
        res.end(JSON.stringify({ ok: true, ...fn(JSON.parse(body)) }));
      } catch (e) {
        res.statusCode = 400;
        res.end(JSON.stringify({ ok: false, error: String(e instanceof Error ? e.message : e) }));
      }
    });
  };
}

/**
 * Dev-only endpoints for the in-game level editor:
 *   POST /__editor/save  { file, text, isNew? }  writes src/levels/<file>; a new level gets a file name
 *                        that doesn't clash with an existing one and is appended to the play order.
 *   POST /__editor/order { order }               rewrites src/levels/order.json (the play order).
 *                        Files left out stay in the folder, "on the shelf".
 */
function levelEditorSave(): Plugin {
  return {
    name: 'thrustlifter-level-save',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(
        '/__editor/save',
        jsonRoute(({ file, text, isNew }) => {
          if (!validName(file)) throw new Error('bad file name');
          JSON.parse(text); // must be valid JSON
          let name = file;
          if (isNew) {
            const base = file.replace(/\.json$/, '');
            for (let n = 2; existsSync(resolve(LEVEL_DIR, name)); n++) name = `${base}-${n}.json`;
          }
          writeFileSync(resolve(LEVEL_DIR, name), text);
          const order = JSON.parse(readFileSync(ORDER_PATH, 'utf8')) as string[];
          if (isNew && !order.includes(name)) {
            order.push(name);
            writeFileSync(ORDER_PATH, JSON.stringify(order) + '\n');
          }
          return { file: name };
        }),
      );
      server.middlewares.use(
        '/__editor/order',
        jsonRoute(({ order }) => {
          if (!Array.isArray(order) || !order.every(validName)) throw new Error('bad order');
          if (new Set(order).size !== order.length) throw new Error('a level is listed twice');
          for (const f of order) if (!existsSync(resolve(LEVEL_DIR, f))) throw new Error(`no such level: ${f}`);
          writeFileSync(ORDER_PATH, JSON.stringify(order) + '\n');
          return {};
        }),
      );
    },
  };
}

export default defineConfig({ plugins: [levelEditorSave()] });
