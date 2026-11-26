import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
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
 *   POST /__editor/save  { file, text, isNew?, renameTo? }  writes src/levels/<file>; a new level gets a file
 *                        name that doesn't clash with an existing one and is appended to the play order;
 *                        renameTo moves an existing level's file to match its new name (same place in the order).
 *   POST /__editor/delete { file }               deletes a shelved level's file (refuses one in the play order).
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
        jsonRoute(({ file, text, isNew, renameTo }) => {
          if (!validName(file)) throw new Error('bad file name');
          JSON.parse(text); // must be valid JSON
          /** `want`, or want-2, want-3... if another level already has that file (`keep` may be reused). */
          const free = (want: string, keep?: string) => {
            const base = want.replace(/\.json$/, '');
            let name = want;
            for (let n = 2; existsSync(resolve(LEVEL_DIR, name)) && name !== keep; n++) name = `${base}-${n}.json`;
            return name;
          };
          const readOrder = () => JSON.parse(readFileSync(ORDER_PATH, 'utf8')) as string[];
          const writeOrder = (o: string[]) => writeFileSync(ORDER_PATH, JSON.stringify(o) + '\n');
          if (isNew) {
            // a new level never overwrites another file, and joins the end of the play order
            const name = free(file);
            writeFileSync(resolve(LEVEL_DIR, name), text);
            const order = readOrder();
            if (!order.includes(name)) writeOrder([...order, name]);
            return { file: name };
          }
          // an existing level: if its name changed, the file follows it (keeping its place in the play order)
          let name = file;
          if (validName(renameTo) && renameTo !== file) name = free(renameTo, file);
          writeFileSync(resolve(LEVEL_DIR, name), text);
          if (name !== file) {
            const order = readOrder();
            writeOrder(order.map((f) => (f === file ? name : f)));
            if (existsSync(resolve(LEVEL_DIR, file))) unlinkSync(resolve(LEVEL_DIR, file));
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
      server.middlewares.use(
        '/__editor/delete',
        jsonRoute(({ file }) => {
          if (!validName(file)) throw new Error('bad file name');
          const order = JSON.parse(readFileSync(ORDER_PATH, 'utf8')) as string[];
          if (order.includes(file)) throw new Error('take it out of the game first');
          if (!existsSync(resolve(LEVEL_DIR, file))) throw new Error(`no such level: ${file}`);
          unlinkSync(resolve(LEVEL_DIR, file));
          return {};
        }),
      );
    },
  };
}

export default defineConfig({ plugins: [levelEditorSave()] });
