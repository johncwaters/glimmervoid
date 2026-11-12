import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const videoDirectory = import.meta.dirname
const fontsDirectory = join(videoDirectory, '../../../public/fonts')
const readBase64 = (path) => readFileSync(path).toString('base64')
const mixPath = join(videoDirectory, 'mix.m4a')
const page = readFileSync(join(videoDirectory, 'template.html'), 'utf8')
  .replace('__FONT400__', readBase64(join(fontsDirectory, 'commit-mono-400-regular.woff2')))
  .replace('__FONT700__', readBase64(join(fontsDirectory, 'commit-mono-700-regular.woff2')))
  .replace('__AUDIO__', existsSync(mixPath) ? readBase64(mixPath) : '')
writeFileSync(join(videoDirectory, 'glimmervoid-boards.html'), page)
console.log(`built glimmervoid-boards.html, ${(page.length / 1e6).toFixed(2)} MB`)
