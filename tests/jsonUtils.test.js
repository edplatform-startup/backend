import { tryParseJson } from '../src/utils/jsonUtils.js';
import { describe, it } from 'node:test';
import assert from 'node:assert';

describe('tryParseJson', () => {
  it('should parse valid JSON', () => {
    const input = '{"key": "value"}';
    assert.deepStrictEqual(tryParseJson(input), { key: 'value' });
  });

  it('should handle markdown fences', () => {
    const input = '```json\n{"key": "value"}\n```';
    assert.deepStrictEqual(tryParseJson(input), { key: 'value' });
  });

  it('should handle trailing commas', () => {
    const input = '{"key": "value",}';
    assert.deepStrictEqual(tryParseJson(input), { key: 'value' });
  });

  it('should handle single quotes for keys', () => {
    const input = "{'key': 'value'}";
    assert.deepStrictEqual(tryParseJson(input), { key: 'value' });
  });

  it('should handle comments', () => {
    const input = '{"key": "value"} // This is a comment';
    assert.deepStrictEqual(tryParseJson(input), { key: 'value' });
  });

  it('should handle truncated JSON (unterminated string)', () => {
    const input = '{"key": "val'; // Should become {"key": "val"}
    assert.deepStrictEqual(tryParseJson(input), { key: 'val' });
  });

  it('should handle truncated JSON (unterminated array)', () => {
    const input = '{"list": [1, 2'; // Should become {"list": [1, 2]}
    assert.deepStrictEqual(tryParseJson(input), { list: [1, 2] });
  });

  it('should handle truncated JSON (nested)', () => {
    const input = '{"a": {"b": "c'; 
    assert.deepStrictEqual(tryParseJson(input), { a: { b: 'c' } });
  });
  
  it('should extract JSON from surrounding text', () => {
    const input = 'Here is the JSON: {"key": "value"} Hope it helps!';
    assert.deepStrictEqual(tryParseJson(input), { key: 'value' });
  });
  
  it('should fail gracefully for completely invalid input', () => {
    const input = 'Not JSON at all';
    assert.throws(() => tryParseJson(input));
  });
});
