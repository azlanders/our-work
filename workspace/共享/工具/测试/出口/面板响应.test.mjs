import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sendJson, isFreshFile, sendPngFile } from '../../出口/面板响应/index.mjs'

function mockRes() {
  const rec = { status: 0, headers: {}, body: null }
  return {
    rec,
    writeHead(status, headers) { rec.status = status; rec.headers = headers },
    end(body) { rec.body = body; return body },
  }
}

test('面板响应: sendJson 写入 JSON 头与内容', () => {
  const res = mockRes()
  sendJson(res, 200, { ok: true, msg: 'hi' })
  assert.equal(res.rec.status, 200)
  assert.match(res.rec.headers['Content-Type'], /application\/json/)
  assert.deepEqual(JSON.parse(res.rec.body), { ok: true, msg: 'hi' })
})

test('面板响应: sendPngFile 缺文件返回 404，存在时返回 PNG 字节', () => {
  const dir = mkdtempSync(join(tmpdir(), 'panel-resp-'))
  try {
    const missing = join(dir, 'nope.png')
    const r404 = mockRes()
    sendPngFile(r404, missing, '还没抓到')
    assert.equal(r404.rec.status, 404)
    assert.equal(JSON.parse(r404.rec.body).msg, '还没抓到')

    const img = join(dir, 'ok.png')
    writeFileSync(img, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const r200 = mockRes()
    sendPngFile(r200, img)
    assert.equal(r200.rec.status, 200)
    assert.equal(r200.rec.headers['Content-Type'], 'image/png')
    assert.equal(r200.rec.body.length, 4)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('面板响应: isFreshFile 正确判断文件新鲜度', () => {
  const dir = mkdtempSync(join(tmpdir(), 'panel-fresh-'))
  try {
    const f = join(dir, 'a.png')
    assert.equal(isFreshFile(f, 4000), false)
    writeFileSync(f, 'x')
    assert.equal(isFreshFile(f, 4000), true)
    const oldSec = (Date.now() - 10000) / 1000
    utimesSync(f, oldSec, oldSec)
    assert.equal(isFreshFile(f, 4000), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
