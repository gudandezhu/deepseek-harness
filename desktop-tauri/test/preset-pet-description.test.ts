import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('built-in pet descriptions', () => {
  it('ships Maid DeepSeek Sticker with pinned preview, config and platform video URLs', () => {
    const source = readFileSync(new URL('../src-tauri/resources/manifest.jsonc', import.meta.url), 'utf8')
    const manifest = JSON.parse(source.replace(/^\s*\/\/.*$/gm, '')) as {
      pets: { 'built-in': { id: string }[] }
    }
    const pets = manifest.pets['built-in']
    const base = 'https://raw.githubusercontent.com/hairyf/dsh-pet-sticker/6634e0de9cace37ac6b747a960c833209ad015a3'

    expect(pets.filter(entry => entry.id === 'dsh-chan-sticker-pet')).toEqual([{
      id: 'dsh-chan-sticker-pet',
      name: 'Maid DeepSeek Sticker',
      desc: '157 个贴纸动作与透明待机动画。',
      image: `${base}/preview/preview.gif`,
      kind: 'dsh',
      size: 220,
      config: `${base}/config.jsonc`,
      uri: { default: `${base}/webm`, mac: `${base}/mov` },
      ext: { default: 'webm', mac: 'mov' },
    }])
    expect(pets[0].id).toBe('maid-deepseek-whale')
  })

  it('describes Maid DeepSeek Whale with the approved Chinese copy', () => {
    const source = readFileSync(new URL('../src-tauri/resources/manifest.jsonc', import.meta.url), 'utf8')
    const manifest = JSON.parse(source.replace(/^\s*\/\/.*$/gm, '')) as {
      pets: { 'built-in': { id: string, desc?: string }[] }
    }
    const pet = manifest.pets['built-in'].find(entry => entry.id === 'maid-deepseek-whale')

    expect(pet?.desc).toBe('一只小小的迷你蓝头发的鲸鱼女仆，穿着海军蓝裙子，白色褶边，蓝眼睛，侧鳍和鲸鱼尾巴。')
  })
})
