import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/**
 * Dev-only endpoint for the in-game level editor: POST /__editor/save { file, text }
 * writes src/levels/<file> and appends it to src/levels/order.json if it's new.
 */
function levelEditorSave(): Plugin {
  return {
    name: 'thrustlifter-level-save',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__editor/save', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          return res.end();
        }
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          try {
            const { file, text } = JSON.parse(body) as { file: string; text: string };
            if (!/^[a-z0-9][a-z0-9-]*\.json$/.test(file) || file === 'order.json') throw new Error('bad file name');
            JSON.parse(text); // must be valid JSON
            const dir = resolve(__dirname, 'src/levels');
            writeFileSync(resolve(dir, file), text);
            const orderPath = resolve(dir, 'order.json');
            const order = JSON.parse(readFileSync(orderPath, 'utf8')) as string[];
            if (!order.includes(file)) {
              order.push(file);
              writeFileSync(orderPath, JSON.stringify(order) + '\n');
            }
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ ok: true, file }));
          } catch (e) {
            res.statusCode = 400;
            res.end(JSON.stringify({ ok: false, error: String(e) }));
          }
        });
      });
    },
  };
}

export default defineConfig({ plugins: [levelEditorSave()] });
