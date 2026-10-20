import { fileURLToPath } from 'node:url'
import { readManifest } from '../../scripts/bundle-metadata.mjs'
import { defineDshConfig } from '../dsh-tauri-tsdown/src/index.ts'
import { gatewayAuthHtml } from './src/host/service/gateway.auth.ts'

// Host half (src/index.ts) + browser client bundle (src/client/index.ts)
// wrapped in the dsh-client-modules closure factory.
// qrcode 只在宿主侧生成二维码：构建期内联，部署树不带 pngjs（其 browserify 产物会让
// 部署闭包校验误判相对引用缺失）；因此它声明为 devDependency 而不是 dependencies。
export default async function () {
  const dshEngine = (readManifest(fileURLToPath(new URL('../..', import.meta.url))).engines as { dsh: { recommend: string, minimum: string } }).dsh
  return defineDshConfig({
    server: {
      noExternal: ['qrcode'],
      define: {
        __GATEWAY_AUTH_HTML__: JSON.stringify(await gatewayAuthHtml()),
        __REMOTE_DSH_RECOMMEND__: JSON.stringify(dshEngine.recommend),
        __REMOTE_DSH_MINIMUM__: JSON.stringify(dshEngine.minimum),
      },
    },
  })
}
