import fs from 'node:fs';
import path from 'node:path';

import { isRecord } from '../shared/coerce.ts';
import { OWNED_COMMAND_SPECS } from '../server/core/cli-spec-core.ts';
import { PACK_SCHEMA_TEXT_BY_NAME } from '../server/packs/packs-cli.ts';
import type { PackSchemaName } from '../server/packs/packs-cli.ts';

type JsonSchema = Record<string, unknown>;
type FieldRow = { path: string; type: string; isRequired: boolean; defaultText: string; description: string };

const REPO_ROOT = path.join(import.meta.dirname, '..');
export const PACKS_REFERENCE_PATH = path.join(REPO_ROOT, 'docs', 'packs-reference.md');
const WORKED_EXAMPLE_PACK = 'pr-radar';
const WORKED_EXAMPLE_MANIFEST_PATH = path.join(REPO_ROOT, 'examples', 'packs', WORKED_EXAMPLE_PACK, 'pack.json');

function parsedSchema(schemaName: PackSchemaName): JsonSchema {
  const parsed: unknown = JSON.parse(PACK_SCHEMA_TEXT_BY_NAME[schemaName]());
  if (!isRecord(parsed)) throw new Error('a pack JSON Schema text is not an object');
  return parsed;
}

function recordsIn(value: unknown): JsonSchema[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function escapeCell(text: string): string {
  return text.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function codeCell(text: string): string {
  return `\`${text.replaceAll('`', "'")}\``;
}

function variantsOf(schema: JsonSchema): JsonSchema[] {
  return [...recordsIn(schema.anyOf), ...recordsIn(schema.oneOf)];
}

function nonNullVariantsOf(schema: JsonSchema): JsonSchema[] {
  return variantsOf(schema).filter((variant) => variant.type !== 'null');
}

function typeNamesOf(schema: JsonSchema): string[] {
  if (typeof schema.type === 'string') return [schema.type];
  return Array.isArray(schema.type) ? schema.type.filter((typeName): typeName is string => typeof typeName === 'string') : [];
}

function hasNullVariant(schema: JsonSchema): boolean {
  return variantsOf(schema).some((variant) => variant.type === 'null') || (Array.isArray(schema.type) && schema.type.includes('null'));
}

function constraintTexts(schema: JsonSchema): string[] {
  const constraintLabels: [string, string][] = [
    ['minLength', 'min length'], ['maxLength', 'max length'], ['minItems', 'min items'], ['maxItems', 'max items'],
    ['minimum', 'min'], ['maximum', 'max'], ['exclusiveMinimum', 'over'], ['exclusiveMaximum', 'under'],
  ];
  const texts = constraintLabels.filter(([key]) => typeof schema[key] === 'number' && Math.abs(Number(schema[key])) < Number.MAX_SAFE_INTEGER).map(([key, label]) => `${label} ${schema[key]}`);
  if (typeof schema.pattern === 'string') texts.push(`matches ${codeCell(schema.pattern)}`);
  if (schema.format === 'uri') texts.push('URL');
  return texts;
}

function baseTypeText(schema: JsonSchema): string {
  if (schema.const !== undefined) return codeCell(JSON.stringify(schema.const));
  if (Array.isArray(schema.enum)) return `one of ${schema.enum.map((value) => codeCell(JSON.stringify(value))).join(', ')}`;
  if (schema.type === 'array') {
    const items = isRecord(schema.items) ? schema.items : {};
    return `array of ${typeText(items)}`;
  }
  const typeNames = typeNamesOf(schema).filter((typeName) => typeName !== 'null');
  if (typeNames.length > 0) return typeNames.join(' or ');
  const variants = nonNullVariantsOf(schema);
  if (variants.length > 0) return variants.map(typeText).join(' or ');
  return 'any JSON value';
}

function typeText(schema: JsonSchema): string {
  const base = [baseTypeText(schema), ...constraintTexts(schema)].join(', ');
  return hasNullVariant(schema) ? `${base}, or null` : base;
}

function singleObjectOf(schema: JsonSchema): JsonSchema | null {
  if (isRecord(schema.properties)) return schema;
  const variants = nonNullVariantsOf(schema);
  if (variants.length === 1 && isRecord(variants[0].properties)) return variants[0];
  return null;
}

function arrayItemObjectOf(schema: JsonSchema): JsonSchema | null {
  const arraySchema = schema.type === 'array' ? schema : nonNullVariantsOf(schema).find((variant) => variant.type === 'array');
  if (!arraySchema || !isRecord(arraySchema.items)) return null;
  return singleObjectOf(arraySchema.items);
}

function objectVariantsOf(schema: JsonSchema): JsonSchema[] {
  const variants = nonNullVariantsOf(schema).filter((variant) => isRecord(variant.properties));
  return variants.length >= 2 ? variants : [];
}

function arrayItemObjectVariantsOf(schema: JsonSchema): JsonSchema[] {
  const arraySchema = schema.type === 'array' ? schema : nonNullVariantsOf(schema).find((variant) => variant.type === 'array');
  return arraySchema && isRecord(arraySchema.items) ? objectVariantsOf(arraySchema.items) : [];
}

function discriminatorLabelOf(variant: JsonSchema, index: number): string {
  const properties = isRecord(variant.properties) ? variant.properties : {};
  const discriminator = Object.entries(properties).find((entry): entry is [string, JsonSchema] => isRecord(entry[1]) && entry[1].const !== undefined);
  return discriminator ? `${discriminator[0]} ${JSON.stringify(discriminator[1].const)}` : `shape ${index + 1}`;
}

function variantRows(variants: readonly JsonSchema[], prefix: string): FieldRow[] {
  return variants.flatMap((variant, index) => fieldRows(variant, `${prefix} (${discriminatorLabelOf(variant, index)}).`));
}

function descriptionOf(schema: JsonSchema): string {
  if (typeof schema.description === 'string') return schema.description;
  const describedVariant = nonNullVariantsOf(schema).find((variant) => typeof variant.description === 'string');
  return typeof describedVariant?.description === 'string' ? describedVariant.description : '';
}

function fieldRows(objectSchema: JsonSchema, prefix: string): FieldRow[] {
  const properties = isRecord(objectSchema.properties) ? objectSchema.properties : {};
  const requiredNames = Array.isArray(objectSchema.required) ? objectSchema.required : [];
  return Object.entries(properties).flatMap(([name, property]) => {
    if (!isRecord(property)) return [];
    const fieldPath = `${prefix}${name}`;
    const row: FieldRow = {
      path: fieldPath, type: typeText(property), isRequired: requiredNames.includes(name) && property.default === undefined,
      defaultText: property.default === undefined ? '' : codeCell(JSON.stringify(property.default)), description: descriptionOf(property),
    };
    const nestedObject = singleObjectOf(property);
    if (nestedObject) return [{ ...row, type: hasNullVariant(property) ? 'object, or null' : 'object' }, ...fieldRows(nestedObject, `${fieldPath}.`)];
    const itemObject = arrayItemObjectOf(property);
    if (itemObject) return [{ ...row, type: [hasNullVariant(property) ? 'array of objects, or null' : 'array of objects', ...constraintTexts(property)].join(', ') }, ...fieldRows(itemObject, `${fieldPath}[].`)];
    const objectVariants = objectVariantsOf(property);
    if (objectVariants.length > 0) return [{ ...row, type: hasNullVariant(property) ? 'one of the objects below, or null' : 'one of the objects below' }, ...variantRows(objectVariants, fieldPath)];
    const itemVariants = arrayItemObjectVariantsOf(property);
    if (itemVariants.length > 0) return [{ ...row, type: [hasNullVariant(property) ? 'array of the objects below, or null' : 'array of the objects below', ...constraintTexts(property)].join(', ') }, ...variantRows(itemVariants, `${fieldPath}[]`)];
    return [row];
  });
}

function fieldTable(rows: readonly FieldRow[]): string[] {
  return [
    '| Field | Type | Required | Default | Meaning |',
    '|---|---|---|---|---|',
    ...rows.map((row) => `| ${codeCell(row.path)} | ${escapeCell(row.type)} | ${row.isRequired ? 'yes' : ''} | ${escapeCell(row.defaultText)} | ${escapeCell(row.description)} |`),
    '',
  ];
}

function describedLines(schema: JsonSchema): string[] {
  const description = descriptionOf(schema);
  return description === '' ? [] : [description, ''];
}

function sectionMarkdown(name: string, property: JsonSchema): string[] {
  const heading = `### \`${name}\``;
  const objectSchema = singleObjectOf(property);
  if (objectSchema) return [heading, '', ...describedLines(property), ...fieldTable(fieldRows(objectSchema, `${name}.`))];
  const itemObject = arrayItemObjectOf(property) ?? {};
  return [heading, '', ...describedLines(property), `A list, ${constraintTexts(property).join(', ') || 'any length'}, of:`, '', ...fieldTable(fieldRows(itemObject, `${name}[].`))];
}

function manifestSectionEntries(): [string, JsonSchema][] {
  const manifest = parsedSchema('pack');
  const properties = isRecord(manifest.properties) ? manifest.properties : {};
  return Object.entries(properties).filter((entry): entry is [string, JsonSchema] => isRecord(entry[1]) && (singleObjectOf(entry[1]) !== null || arrayItemObjectOf(entry[1]) !== null));
}

function manifestMarkdown(): string[] {
  const manifest = parsedSchema('pack');
  const properties = isRecord(manifest.properties) ? manifest.properties : {};
  const sectionEntries = manifestSectionEntries().filter(([name]) => name !== 'requires');
  const sectionNames = new Set(sectionEntries.map(([name]) => name));
  const topLevelRows = fieldRows({ ...manifest, properties: Object.fromEntries(Object.entries(properties).filter(([name]) => !sectionNames.has(name))) }, '');
  return [
    '## pack.json',
    '',
    `Published as the JSON Schema ${codeCell(String(manifest.$id))}; point \`$schema\` at it for editor completion. \`glimmervoid packs guide --schema pack\` prints the same schema.`,
    '',
    '### Top level',
    '',
    ...fieldTable([...topLevelRows, ...sectionEntries.map(([name, property]) => ({ path: name, type: singleObjectOf(property) ? 'object' : 'array of objects', isRequired: false, defaultText: '', description: `${descriptionOf(property)} See below.`.trim() }))]),
    ...sectionEntries.flatMap(([name, property]) => sectionMarkdown(name, property)),
  ];
}

function constOf(schema: JsonSchema, fieldName: string): string | null {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const field = properties[fieldName];
  return isRecord(field) && typeof field.const === 'string' ? field.const : null;
}

function messageMarkdown(message: JsonSchema): string[] {
  const kind = constOf(message, 'kind') ?? 'message';
  const topic = constOf(message, 'topic');
  const title = topic === null ? `\`${kind}\`` : `\`${kind}\`: \`${topic}\``;
  return [`#### ${title}`, '', ...describedLines(message), ...fieldTable(fieldRows(message, ''))];
}

function bridgeMarkdown(): string[] {
  const bridge = parsedSchema('bridge');
  const panelToHost = isRecord(bridge.panelToHost) ? variantsOf(bridge.panelToHost) : [];
  const hostToPanel = isRecord(bridge.hostToPanel) ? variantsOf(bridge.hostToPanel) : [];
  return [
    '## Panel bridge',
    '',
    'Messages a panel and the dashboard exchange with `postMessage`. `glimmervoid packs guide --schema bridge` prints them as JSON Schema.',
    '',
    '### Panel to dashboard',
    '',
    ...panelToHost.flatMap(messageMarkdown),
    '### Dashboard to panel',
    '',
    ...hostToPanel.flatMap(messageMarkdown),
  ];
}

function panelActionsMarkdown(): string[] {
  const actions = parsedSchema('actions');
  return [
    '## Panel actions',
    '',
    'The `request` of an `action` message, by `request.type`. Review actions need `reviews` under the panel `acts`; session actions need `sessions`. `glimmervoid packs guide --schema actions` prints them as JSON Schema.',
    '',
    ...Object.entries(actions).flatMap(([type, schema]) => (isRecord(schema) ? [`### \`${type}\``, '', ...describedLines(schema), ...fieldTable(fieldRows(schema, ''))] : [])),
  ];
}

function prFlowsOutputMarkdown(): string[] {
  const outputs = parsedSchema('pr-flows');
  const titleByName: Readonly<Record<string, string>> = { sourceOutput: 'What a source command prints', actionOutcome: 'What a prAction or action command prints' };
  return [
    '## prFlows command output',
    '',
    'Each prFlows command prints one JSON object on stdout. `glimmervoid packs guide --schema pr-flows` prints these as JSON Schema.',
    '',
    ...Object.entries(outputs).flatMap(([name, schema]) => (isRecord(schema) ? [`### ${titleByName[name] ?? name}`, '', ...describedLines(schema), ...fieldTable(fieldRows(schema, ''))] : [])),
  ];
}

function cliMarkdown(): string[] {
  const packsCommand = OWNED_COMMAND_SPECS.packs;
  return [
    '## The `glimmervoid packs` command',
    '',
    `${packsCommand.summary}.`,
    '',
    '| Command | What it does |',
    '|---|---|',
    ...packsCommand.subcommands.map((subcommand) => {
      const positionalText = 'positionals' in subcommand ? ` ${subcommand.positionals.usage}` : '';
      const optionTexts = 'options' in subcommand ? subcommand.options.map((option) => `\`--${option.name}${option.type === 'string' ? ` <${option.valueName}>` : ''}\`: ${option.summary}`) : [];
      return `| \`glimmervoid packs ${subcommand.name}${positionalText}\` | ${escapeCell([subcommand.summary, ...optionTexts].join('. '))} |`;
    }),
    '',
  ];
}

function otherExampleLines(): string[] {
  const sectionNames = manifestSectionEntries().map(([name]) => name);
  const examplesDir = path.dirname(path.dirname(WORKED_EXAMPLE_MANIFEST_PATH));
  return fs.readdirSync(examplesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== WORKED_EXAMPLE_PACK)
    .map((entry) => entry.name)
    .sort()
    .map((exampleName) => {
      const manifest: unknown = JSON.parse(fs.readFileSync(path.join(examplesDir, exampleName, 'pack.json'), 'utf8'));
      const usedSectionNames = isRecord(manifest) ? sectionNames.filter((name) => Object.hasOwn(manifest, name)) : [];
      return `- [\`${exampleName}\`](../examples/packs/${exampleName}/): ${usedSectionNames.map((name) => `\`${name}\``).join(', ')}`;
    });
}

function exampleMarkdown(): string[] {
  const manifestText = fs.readFileSync(WORKED_EXAMPLE_MANIFEST_PATH, 'utf8').replaceAll('\r\n', '\n').trimEnd();
  return [
    '## Worked example',
    '',
    `The \`pack.json\` of [\`examples/packs/${WORKED_EXAMPLE_PACK}/\`](../examples/packs/${WORKED_EXAMPLE_PACK}/). The example-packs gate runs \`glimmervoid packs check\` on every folder in \`examples/packs\`, so this example always loads.`,
    '',
    '```json',
    manifestText,
    '```',
    '',
    'The other examples, by the sections they use:',
    '',
    ...otherExampleLines(),
    '',
  ];
}

export function renderPacksReference(): string {
  const lines = [
    '# Packs reference',
    '',
    'Every field, message and command a pack uses. Generated from the Zod contracts by `npm run docs:packs`, so do not edit it by hand; fix a description at its `.describe()` in `shared/contracts/` and regenerate. Why packs work the way they do: [packs.md](packs.md).',
    '',
    ...manifestMarkdown(),
    ...bridgeMarkdown(),
    ...panelActionsMarkdown(),
    ...prFlowsOutputMarkdown(),
    ...cliMarkdown(),
    ...exampleMarkdown(),
  ];
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

if (process.argv[1] === import.meta.filename) {
  fs.writeFileSync(PACKS_REFERENCE_PATH, renderPacksReference(), 'utf8');
  console.log(`Wrote ${path.relative(process.cwd(), PACKS_REFERENCE_PATH)}`);
}
