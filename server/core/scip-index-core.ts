export const SCIP_SYMBOL_ROLES = Object.freeze({
  definition: 0x1,
  import: 0x2,
  test: 0x20,
});

interface ScipOccurrence {
  startLine: number;
  startCharacter: number;
  symbol: string;
  roles: number;
  enclosingRange: ScipSpan | null;
}

interface ScipSpan {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
}

export interface ScipDocument {
  relativePath: string;
  language: string;
  occurrences: ScipOccurrence[];
}

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LENGTH_DELIMITED = 2;
const WIRE_FIXED32 = 5;

const INDEX_DOCUMENTS = 2;
const DOCUMENT_RELATIVE_PATH = 1;
const DOCUMENT_OCCURRENCES = 2;
const DOCUMENT_LANGUAGE = 4;
const OCCURRENCE_RANGE = 1;
const OCCURRENCE_SYMBOL = 2;
const OCCURRENCE_ROLES = 3;
const OCCURRENCE_ENCLOSING_RANGE = 7;
const OCCURRENCE_SINGLE_LINE_RANGE = 8;
const OCCURRENCE_MULTI_LINE_RANGE = 9;
const OCCURRENCE_SINGLE_LINE_ENCLOSING_RANGE = 10;
const OCCURRENCE_MULTI_LINE_ENCLOSING_RANGE = 11;

interface WireField {
  fieldNumber: number;
  isLengthDelimited: boolean;
  varint: number;
  start: number;
  end: number;
}

interface Reader {
  bytes: Uint8Array;
  offset: number;
}

const textDecoder = new TextDecoder();

function readVarint(reader: Reader): number {
  let value = 0;
  let multiplier = 1;
  for (;;) {
    if (reader.offset >= reader.bytes.length) throw new Error('SCIP index ends inside a varint');
    const byte = reader.bytes[reader.offset++];
    value += (byte & 0x7f) * multiplier;
    if ((byte & 0x80) === 0) return value;
    multiplier *= 128;
  }
}

function* fieldsOf(bytes: Uint8Array, start: number, end: number): Generator<WireField> {
  const reader: Reader = { bytes, offset: start };
  while (reader.offset < end) {
    const key = readVarint(reader);
    const fieldNumber = Math.floor(key / 8);
    const wireType = key % 8;
    if (wireType === WIRE_VARINT) {
      yield { fieldNumber, isLengthDelimited: false, varint: readVarint(reader), start: 0, end: 0 };
      continue;
    }
    if (wireType === WIRE_LENGTH_DELIMITED) {
      const length = readVarint(reader);
      const fieldStart = reader.offset;
      reader.offset += length;
      if (reader.offset > end) throw new Error('SCIP index field runs past its message');
      yield { fieldNumber, isLengthDelimited: true, varint: 0, start: fieldStart, end: reader.offset };
      continue;
    }
    if (wireType === WIRE_FIXED64) {
      reader.offset += 8;
      continue;
    }
    if (wireType === WIRE_FIXED32) {
      reader.offset += 4;
      continue;
    }
    throw new Error(`SCIP index holds unsupported wire type ${wireType}`);
  }
}

function appendRepeatedInts(bytes: Uint8Array, field: WireField, values: number[]): void {
  if (!field.isLengthDelimited) {
    values.push(field.varint | 0);
    return;
  }
  const reader: Reader = { bytes, offset: field.start };
  while (reader.offset < field.end) values.push(readVarint(reader) | 0);
}

function spanOfPacked(values: readonly number[]): ScipSpan | null {
  if (values.length === 3) return { startLine: values[0], startCharacter: values[1], endLine: values[0], endCharacter: values[2] };
  if (values.length === 4) return { startLine: values[0], startCharacter: values[1], endLine: values[2], endCharacter: values[3] };
  return null;
}

function spanOfSingleLine(bytes: Uint8Array, field: WireField): ScipSpan {
  const values = [0, 0, 0];
  for (const part of fieldsOf(bytes, field.start, field.end)) values[part.fieldNumber - 1] = part.varint | 0;
  return { startLine: values[0], startCharacter: values[1], endLine: values[0], endCharacter: values[2] };
}

function spanOfMultiLine(bytes: Uint8Array, field: WireField): ScipSpan {
  const values = [0, 0, 0, 0];
  for (const part of fieldsOf(bytes, field.start, field.end)) values[part.fieldNumber - 1] = part.varint | 0;
  return { startLine: values[0], startCharacter: values[1], endLine: values[2], endCharacter: values[3] };
}

function occurrenceOf(bytes: Uint8Array, start: number, end: number): ScipOccurrence | null {
  const rangeValues: number[] = [];
  let typedRange: ScipSpan | null = null;
  const enclosingRangeValues: number[] = [];
  let typedEnclosingRange: ScipSpan | null = null;
  let symbol = '';
  let roles = 0;
  for (const field of fieldsOf(bytes, start, end)) {
    if (field.fieldNumber === OCCURRENCE_RANGE) appendRepeatedInts(bytes, field, rangeValues);
    if (field.fieldNumber === OCCURRENCE_SINGLE_LINE_RANGE) typedRange = spanOfSingleLine(bytes, field);
    if (field.fieldNumber === OCCURRENCE_MULTI_LINE_RANGE) typedRange = spanOfMultiLine(bytes, field);
    if (field.fieldNumber === OCCURRENCE_SYMBOL) symbol = textDecoder.decode(bytes.subarray(field.start, field.end));
    if (field.fieldNumber === OCCURRENCE_ROLES) roles = field.varint;
    if (field.fieldNumber === OCCURRENCE_ENCLOSING_RANGE) appendRepeatedInts(bytes, field, enclosingRangeValues);
    if (field.fieldNumber === OCCURRENCE_SINGLE_LINE_ENCLOSING_RANGE) typedEnclosingRange = spanOfSingleLine(bytes, field);
    if (field.fieldNumber === OCCURRENCE_MULTI_LINE_ENCLOSING_RANGE) typedEnclosingRange = spanOfMultiLine(bytes, field);
  }
  const range = typedRange ?? spanOfPacked(rangeValues);
  if (range === null || symbol === '') return null;
  return { startLine: range.startLine, startCharacter: range.startCharacter, symbol, roles, enclosingRange: typedEnclosingRange ?? spanOfPacked(enclosingRangeValues) };
}

function documentOf(bytes: Uint8Array, start: number, end: number): ScipDocument {
  const document: ScipDocument = { relativePath: '', language: '', occurrences: [] };
  for (const field of fieldsOf(bytes, start, end)) {
    if (field.fieldNumber === DOCUMENT_RELATIVE_PATH) document.relativePath = textDecoder.decode(bytes.subarray(field.start, field.end));
    if (field.fieldNumber === DOCUMENT_LANGUAGE) document.language = textDecoder.decode(bytes.subarray(field.start, field.end));
    if (field.fieldNumber !== DOCUMENT_OCCURRENCES) continue;
    const occurrence = occurrenceOf(bytes, field.start, field.end);
    if (occurrence !== null) document.occurrences.push(occurrence);
  }
  return document;
}

export function* scipDocumentsOf(bytes: Uint8Array): Generator<ScipDocument> {
  for (const field of fieldsOf(bytes, 0, bytes.length)) {
    if (field.fieldNumber === INDEX_DOCUMENTS) yield documentOf(bytes, field.start, field.end);
  }
}
