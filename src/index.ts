import "core-js/stable";
import "regenerator-runtime/runtime";
import * as Fs from "fs";
import {promisify} from 'util'
import * as Path from "path";
import * as express from "express";
import {RequestHandler} from "express";

const defaultConfig = {
  //本地路由根目录，相对于package.json，会按照顺序搜索
  realPrefix: [],
  //该目录下的不会作为路由文件，但是会被检测热更新
  libPrefix: [],
  //当请求目标为目录时，按照此顺序寻找对应的路由
  autoIndex: ["index", "index.html", "index.js"],
  //屏蔽符合以下条件的文件（对路由文件无效），支持文件名通配、正则和自定义函数。参数为本地真实路径
  ignore: [
    '*.ts',
    '*.lib.js',
    '*.json',
    s => s.endsWith('.map'),
    /\/config\..+$/
  ],
}


type FsWatchCallback = (event: 'rename' | 'change', filename: string) => any

async function watchRecursively(path: string, extraCallback?: FsWatchCallback) {
  let watchers: Record<string, Fs.FSWatcher> = {}

  const callback: FsWatchCallback = async (event, filename) => {
    extraCallback(event, filename)
    let stat
    try {
      stat = await promisify(Fs.stat)(filename)
    } catch (e) {}

    if (event == "rename" && !stat) {
      watchers[filename]?.close()
      delete watchers[filename]
    }
    else if (event == "rename" && stat && stat.isDirectory()) {
      watch(filename)
    }
  }

  function watch(dirname: string = path) {
    (async () => {
      watchers[dirname]?.close()
      watchers[dirname] = Fs.watch(dirname,
        (event, filename) => {
          try {
            callback(event as any, Path.join(dirname, filename))
          } catch (e) {
            console.warn(e.message)
          }
        })
        .addListener('error', (err: any) => {
            console.warn(err.message, dirname)
          }
        )
      for await(let dir of await promisify(Fs.opendir)(dirname)) {
        if (dir.isDirectory())
          watch(Path.join(dirname, dir.name))
      }
    })().catch(reason => {
      console.warn(reason.message)
    })
  }

  watch()

}

function wrapIgnorance(re: string | RegExp | ((s: string) => boolean)): ((s: string) => boolean) {
  if (typeof re === "string") {
    return wrapIgnorance(
      new RegExp(re.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          .replace('\\*', '[^.*?/\\:]+')
          .replace('\\?', '[^.*?/\\:]')
        + '$', 'is')
    )
  } else if (typeof re === "object") {
    return wrapIgnorance((s: string) => !!s.match(re))
  } else {
    return (s) => re(s.replace(new RegExp('\\' + Path.sep, 'g'), '/'))
  }
}

function sendFileRouter(file: string): RequestHandler {
  return ((req, res) => {
    res.sendFile(Path.resolve(file))
  })
}

class DynamicRouter {
  config: typeof defaultConfig

  constructor(config: typeof defaultConfig) {
    this.config = config
  }

  findListener(url: string, req?: express.Request, autoIndex = false): express.Router | RequestHandler | null {
    for (let realPrefix of this.config.realPrefix) {
      const targetFile = Path.join(realPrefix, url || '/')
      //如果目标是js文件（有后缀）
      if (Fs.existsSync(targetFile) && targetFile.endsWith('.js')) {
        //且不被屏蔽
        for (let ignoreElement of this.config.ignore)
          if ((ignoreElement as Function)(targetFile))
            return null
        let filename = Path.resolve(targetFile).replace(/\\/g, '/')
        let module = require(filename)
        module = module?.default || module
        // 如果是函数类型的对象，就返回路由
        // 这里注意判断router所用的express原型应与app的保持一致（否则可能由于express版本不同导致出问题）
        if (module && typeof module == "function")
          module.__erd_have_loaded = true // 为所有load进来的路由对象增加一个标志。
          return module as express.Router
        //否则继续处理（因为考虑到网站可能会有浏览器直接加载的js文件静态分发的情况）
      }
      //如果存在对应js文件
      if (Fs.existsSync(targetFile + '.js'))
        return this.findListener(url + '.js', req)

      // 如果目标原始路径存在
      if (Fs.existsSync(targetFile)) {
        //且不被屏蔽
        for (let ignoreElement of this.config.ignore)
          if ((ignoreElement as Function)(targetFile))
            return null
        const fileStatus = Fs.statSync(targetFile)
        if (fileStatus.isFile())
          //如果是文件直接返回
          return sendFileRouter(targetFile)
        else if (fileStatus.isDirectory() && autoIndex) {
          //如果是目录或无后缀的js
          //按autoIndex顺序依次检查目录下的文件
          let router = null
          for (const filename of this.config.autoIndex)
            //查找到了就返回
            if ((router = this.findListener(url + '/' + filename, req)))
              return router
        }
      }
    }
    return null
  }
}

export function dynamicRouter(userConfig: Partial<typeof defaultConfig>): RequestHandler {
  const config = Object.fromEntries(Object.entries(defaultConfig).map(([k, v]) => [k, userConfig?.[k] || v])) as typeof defaultConfig
  if (typeof config.realPrefix === "string") config.realPrefix = [config.realPrefix]
  if (typeof config.libPrefix === "string") config.libPrefix = [config.libPrefix]
  config.ignore = config.ignore.map(value => wrapIgnorance(value))

  const manager = new DynamicRouter(config)
  for (let path of [...config.realPrefix, ...config.libPrefix]) {
    watchRecursively(Path.resolve(path), (event, filename) => {
      console.log(event, filename)
      let cacheObj = require.cache?.[filename]
      if (cacheObj) {
        let module = cacheObj.exports?.default || cacheObj.exports
        if (typeof module === "function" && module.__erd_have_loaded) {
          // 当require过的路由模块（通过__erd_have_loaded属性来识别）即将被移除出缓存时，尝试调用其的onDestroy生命周期函数
          let onDestroy = cacheObj.exports?.default?.onDestroy || cacheObj.exports?.onDestroy
          if (typeof onDestroy === "function" && !onDestroy.__erd_hava_called) {
            console.log("call onDestroy() of " + filename)
            try {onDestroy.call(module)} catch (e) {console.error(e)}
          }
        }
      }
      delete require.cache?.[filename]
    })
  }
  return (req, res, next) => {
    let listener
    let autoIndex = true
    let questionMarkIndex = req.url.indexOf("?")
    let originPath = (questionMarkIndex === -1? req.url: req.url.substring(0, questionMarkIndex))
    // 正规化路径，防止其越过站点根目录
    originPath = Path.normalize(originPath)
    let currentFindPath = originPath.replace(/\/+$/, '') || '/'
    // 对于获得的形如/aaa/bbb/ccc形式的url，应当依次查找/aaa/bbb/ccc、/aaa/bbb、/aaa、/ 四种listener，
    // 并在调用listener之前从req.url中删除已经匹配到的部分。
    // 例如，现在存在文件aaa/bbb.js，则应当以req.url="/ccc"来调用bbb.js中定义的Router。
    // 这是为了保证如果bbb.js中有router.get("/ccc", ()=>{})这样的语句时能够正确处理。

    while (true) {
      listener = manager.findListener(currentFindPath, req, autoIndex)
      if (listener || currentFindPath === "/") break // 找到了，或者已经找完根路径了，就立即停止查找
      currentFindPath = Path.dirname(currentFindPath) // 否则，在父路径查找
      autoIndex = false
    }

    if (listener) {
      if (currentFindPath !== "/") req.baseUrl += currentFindPath
      req.url = '/' + Path.relative(currentFindPath, req.url || '/').replace(/\\/g, "/")
      // 经测试发现，Path.relative('/aaa', '/aaa/bbb/')返回的是'bbb'。因此特判这种情况，在url最后加上一个/。
      if (req.url.charAt(req.url.length - 1) !== "/" && originPath.charAt(originPath.length - 1) === "/") req.url += "/"
      listener(req, res, next)
    }
    else
      next()
  }
}
