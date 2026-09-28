import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
const root = fileURLToPath(new URL('.', import.meta.url));
async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) =>
        entry.isDirectory()
          ? files(resolve(directory, entry.name))
          : Promise.resolve(
              entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')
                ? [resolve(directory, entry.name)]
                : [],
            ),
      ),
    )
  ).flat();
}
describe('core extraction boundary', () => {
  it('does not import feedback modules or the application database schema', async () => {
    const violations: string[] = [];
    for (const file of await files(root)) {
      const source = ts.createSourceFile(
        file,
        await readFile(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      );
      for (const statement of source.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
          continue;
        const specifier = statement.moduleSpecifier.text;
        if (!specifier.startsWith('.')) continue;
        const target = resolve(dirname(file), specifier);
        if (!target.startsWith(root) && !target.startsWith(resolve(root, '../../shared') + '/'))
          violations.push(`${file}: ${specifier}`);
      }
    }
    expect(violations).toEqual([]);
  });
  it('keeps money and tax calculations independent of HTTP and PostgreSQL', async () => {
    const forbidden: string[] = [];
    for (const name of ['money.ts', 'billing.ts', 'validation.ts']) {
      const text = await readFile(resolve(root, 'domain', name), 'utf8');
      if (/from ['"](?:drizzle|fastify|.*\/http\/|.*\/persistence\/)/.test(text))
        forbidden.push(name);
    }
    expect(forbidden).toEqual([]);
  });
});
