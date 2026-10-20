import process from 'node:process'
import { assertPreconditions, WEBDRIVER_PORT } from './support/desktop'

export default async function setup(): Promise<void> {
  await assertPreconditions()
  process.stdout.write(`[desktop-setup] WebDriver 端口 ${WEBDRIVER_PORT} 空闲，debug 二进制就绪\n`)
}
