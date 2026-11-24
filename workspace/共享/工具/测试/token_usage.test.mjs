import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const path = process.env.USAGE_MODULE || new URL('../usage-解析.mjs', import.meta.url).href
const { 抠usage } = await import(path)
const cases = [
 ['missing', '{"usage":{"input_tokens":10}}', 10, 0, false],
 ['explicit zero', '{"usage":{"prompt_tokens":10,"prompt_cache_hit_tokens":0}}', 10, 0, true],
 ['openai details', '{"usage":{"prompt_tokens":100,"prompt_tokens_details":{"cached_tokens":80}}}', 100, 80, true],
 ['anthropic', '{"input_tokens":10,"cache_read_input_tokens":80,"cache_creation_input_tokens":5}', 95, 80, true],
 ['deepseek', '{"prompt_tokens":100,"prompt_cache_hit_tokens":80,"prompt_cache_miss_tokens":20}', 100, 80, true],
 ['stream max', 'data: {"prompt_tokens":100,"prompt_cache_hit_tokens":80}\ndata: {"prompt_tokens":100,"prompt_cache_hit_tokens":80}', 100, 80, true],
 ['unrelated cached field', '{"prompt_tokens":100,"other":{"cached_tokens":80}}', 100, 0, false],
 ['empty', '', 0, 0, false],
]
for (const [name, text, input, cache, known] of cases) {
 const actual = 抠usage(text)
 assert.equal(actual.输入, input, name + ' input')
 assert.equal(actual.缓读, cache, name + ' cache')
 assert.equal(actual.缓读已知, known, name + ' known')
}
console.log('8 usage cases passed')
