/**
 * 录一段产品演示视频。
 *
 * 内容：
 *   1. SmartCity 3D：白模城区鸟瞰 → 点选一辆车跟踪（chase）→ 切驾驶视角
 *   2. AI Proving Ground：列出 checkpoints → 加载训好的策略 → 选回放目标 → 开始回放
 *   3. 客户端路由回 SceneLab：看**策略在开车**（它会开到路口前并按灯停车）
 *
 * 前置（都必须是本项目自己的进程，端口 5173 / 8000 属于别的项目）：
 *   后端：cd TraffSim3D-backend
 *         $env:PPO_CHECKPOINT_DIR = '<有 checkpoint 的目录>'
 *         .\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8001
 *   前端：cd TraffSim3D-frontend
 *         $env:VITE_BACKEND_PORT  = '8001'
 *         $env:VITE_BACKEND_URL   = 'http://localhost:8001'
 *         npm run dev -- --port 5188
 *
 * 用法：
 *   node scripts/record-demo.mjs --out ../docs/media/traffsim3d-demo.webm
 *
 * 两个环境变量都要设：VITE_BACKEND_PORT 给 vite 代理用，VITE_BACKEND_URL 给
 * 视图里的直连 fetch 用（AI Playground 用后者，缺了就退回 8000 而连不上）。
 *
 * 产物：一个无声的 .webm。headless Chromium 走 SwiftShader 软件光栅 ⇒
 * 画面是**悲观**的（真实 GPU 上更流畅）。
 */
import { chromium } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}

const URL = argOf('url', 'http://127.0.0.1:5188')
const OUT = path.resolve(process.cwd(), argOf('out', '../docs/media/traffsim3d-demo.webm'))
const TMP_DIR = path.resolve(process.cwd(), '..', '.data', 'demo_video_tmp')
const SCENE_SECONDS = Number(argOf('scene-seconds', '24'))
// The grid segment (the RL signal policy commanding 25 junctions) gets
// its own length: it is the closing shot, and it is short on purpose —
// the video is 100 seconds, not three.
const GRID_SECONDS = Number(argOf('grid-seconds', '12'))

const waitFor = async (page, fn, timeout = 40_000) => {
  await page.waitForFunction(fn, undefined, { timeout })
}

const main = async () => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true })
  fs.mkdirSync(TMP_DIR, { recursive: true })
  fs.mkdirSync(path.dirname(OUT), { recursive: true })

  const browser = await chromium.launch()
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    recordVideo: { dir: TMP_DIR, size: { width: 1280, height: 800 } },
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 160)))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text().slice(0, 160))
  })

  // --- 1) SmartCity 3D：白模城区 + 跟踪 + 驾驶 --------------------------
  await page.goto(`${URL}/smart-city`, { waitUntil: 'domcontentloaded' })
  await waitFor(
    page,
    () => {
      const el = document.querySelector('[data-testid="osm-building-count"]')
      return Boolean(el && Number((el.textContent ?? '0').replace(/\D/g, '')) > 0)
    },
    90_000,
  )
  console.log('city drawn')
  // 给瓦片链一点时间细化（预取把祖先铺好了，细节级还在走）。
  await page.waitForTimeout(9_000)
  // 收起面板，画面留给城市。
  const toggle = page.locator('[data-testid="toggle-panels"]')
  if (await toggle.count()) await toggle.click()
  await page.waitForTimeout(1_500)

  // ===== 限高门架：公交进不去的那一段 ==============================
  //
  // 春风隧道是随包城区里唯一带 `maxheight` 的路（3.5 m）。这一段
  // 把它讲清楚：**公交停在门口，小车从它旁边过去**。
  //
  // 两辆车是"放"上去的（生成器把车撒在一千多条路上，不会正好落在
  // 隧道口）。放的时候实体与刚体一起放在车道点上 —— `moveVehicleTo`
  // 会重新吸附到全网最近的车道，那条路未必是隧道。
  // 布景期间把底栏藏起来：车道守卫会为「手放的车」记一条事件，
  // 那是制作过程的注脚，不该出现在演示片里。布景结束后清空事件流
  // 并把底栏放回来。
  await page.addStyleTag({ content: '.bottom-bar { visibility: hidden !important; }' })
  const gantry = await page.evaluate(async () => {
    const ra = await import('/src/domain/services/roadAccess.ts')
    const geo = await import('/src/domain/services/laneGeometry.ts')
    const w = window.__world
    const limited = Object.values(w.network.roads).filter((r) => ra.roadHeightLimitM(r) !== null)
    // 选那条「车流方向的前端就是门架」的路：门架立在路的末端，
    // 顺着车流方向才撞得到它。
    const tunnel =
      limited.find((r) => {
        const wps = geo.roadWaypoints(r)
        const last = wps[wps.length - 1]
        return Object.values(w.network.intersections).some(
          (i) =>
            (i.connectedRoads ?? []).includes(r.id) &&
            Math.hypot(i.position.x - last.x, i.position.z - last.z) < 8,
        )
      }) ?? limited[0]
    if (!tunnel) return null
    const len = geo.roadLength(tunnel)
    const spec = w.getRapierWorld()
    // 离门架 75 m（公交）与 100 m（小车）：两条隧道路在另一端汇合，
    // 靠近汇合点时 tick 的车道吸附会挑到**平行的那条**路，车就会朝
    // 反方向开走。
    const place = (type, back) => {
      const s = Math.max(0, Math.min(len, len - back))
      const lp = geo.lanePoint(tunnel, 0, s)
      const car = Object.values(w.network.vehicles).find((v) => v.type === type && !v.__staged)
      if (!car) return null
      car.__staged = true
      const v = w.network.vehicles[car.id]
      v.roadId = tunnel.id
      v.laneIndex = 0
      v.s = s
      v.position = { x: lp.position.x, y: lp.position.y, z: lp.position.z }
      v.heading = lp.heading
      v.speed = 9
      v.targetSpeed = 9
      v.status = 'driving'
      v.desiredStatus = 'driving'
      spec?.setVehiclePosition(car.id, { x: lp.position.x, y: lp.position.y, z: lp.position.z })
      spec?.setVehicleSpeed(car.id, 9, lp.heading)
      return { id: car.id, s: +s.toFixed(1) }
    }
    const bus = place('bus', 75)
    const car = place('car', 100)
    if (car) w.setRideVehicle(car.id, 'chase')
    return { tunnel: tunnel.id, limit: ra.roadHeightLimitM(tunnel), bus, car }
  })
  console.log('gantry:', JSON.stringify(gantry))
  if (!gantry?.car) throw new Error('could not stage the height-gantry shot')

  // 两段式放置：先让 tick 的车道同步自己选好车道，再按它选中的
  // roadId/laneIndex/s 把车**精确**放回那个车道点。只放一次的话，
  // 车与 tick 认定的车道差着 5 m，车道守卫会每帧把它拽回去（而且
  // 每次都记一条事件）。
  await page.waitForTimeout(2_500)
  const exact = await page.evaluate(
    async (ids) => {
      const geo = await import('/src/domain/services/laneGeometry.ts')
      const w = window.__world
      const spec = w.getRapierWorld()
      const out = {}
      for (const [key, id] of Object.entries(ids)) {
        const v = w.network.vehicles[id]
        if (!v) continue
        const road = w.network.roads[v.roadId]
        if (!road) continue
        const lp = geo.lanePoint(road, v.laneIndex, v.s)
        v.position = { x: lp.position.x, y: lp.position.y, z: lp.position.z }
        v.heading = lp.heading
        spec?.setVehiclePosition(id, { x: lp.position.x, y: lp.position.y, z: lp.position.z })
        spec?.setVehicleSpeed(id, v.speed, lp.heading)
        out[key] = { roadId: v.roadId, laneIndex: v.laneIndex, s: +v.s.toFixed(1) }
      }
      return out
    },
    { bus: gantry.bus.id, car: gantry.car.id },
  )
  console.log('gantry lanes:', JSON.stringify(exact))
  await page.waitForTimeout(1_200)
  // 手放车辆的自述（"已拉回"）不该留在演示片里。
  await page.evaluate(() => window.__clearCityEvents?.())
  await page.evaluate(() => {
    document.querySelectorAll('style').forEach((el) => {
      if (el.textContent?.includes('.bottom-bar { visibility: hidden')) el.remove()
    })
  })

  // 跟踪一辆在跑的车（与产品点击拾取走同一个 store 入口）。
  const ride = await page.evaluate(() => {
    const w = window.__world
    // `__staged` 的两辆是门架那一段的主角，别抢。
    const car = Object.values(w.network.vehicles).find(
      (v) => v.type === 'car' && v.speed > 4 && !v.__staged,
    )
    if (!car) return null
    w.setRideVehicle(car.id, 'chase')
    return car.id
  })
  console.log('tracking:', ride)
  await page.waitForTimeout(8_000)

  // 驾驶舱：**一辆有信号灯的路段上的车**，这样仪表盘不只有速度，
  // 还有前方信号灯的倒计时与灯色 —— 那是仪表盘上唯一会自己变化的
  // 读数，也是这段镜头要讲的东西。
  const cockpitRide = await page.evaluate(() => {
    const w = window.__world
    // The junctions that have a light, and the roads that reach them.
    const signalledRoads = new Set()
    for (const inter of Object.values(w.network.intersections)) {
      if ((inter.trafficLights ?? []).length > 0) {
        for (const id of inter.connectedRoads ?? []) signalledRoads.add(id)
      }
    }
    const candidates = Object.values(w.network.vehicles)
      .filter((v) => v.type === 'car' && v.speed > 4 && signalledRoads.has(v.roadId) && !v.__staged)
      .sort((a, b) => b.speed - a.speed)
    const car = candidates[0]
    if (!car) return null
    w.setRideVehicle(car.id, 'cockpit')
    return car.id
  })
  console.log('cockpit:', cockpitRide)
  await page.waitForTimeout(9_000)

  // 窄巷限行杆：找一辆**正在驶向窄巷口**的车，用产品自己的跟车镜头拍。
  //
  // 限行杆只有 0.25 m 宽，靠相机硬算取景不可靠；换成"跟着一辆会经过
  // 它��车"，画面里就有那根红杆与它挡住的那条暗巷。
  const alleyRide = await page.evaluate(() => {
    const w = window.__world
    // The width rule, as the domain states it (roadAccess.ts): the lane
    // metres per OSM class, one lane for the narrow classes.
    const LANE = { unclassified: 2.2, living_street: 2.2, service: 1.8 }
    const barred = (r) => {
      const cls = (r.highway ?? '').toLowerCase()
      const lanes =
        cls === 'unclassified' || cls === 'living_street' || cls === 'service'
          ? 1
          : Math.max(1, r.laneCount ?? 2)
      return lanes * (LANE[cls] ?? 3.0) < 2.4
    }
    const barredIds = new Set(
      Object.values(w.network.roads)
        .filter(barred)
        .map((r) => r.id),
    )
    // The junctions where a narrow lane meets a road a car may use —
    // the barrier stands at those mouths.
    const mouths = []
    for (const inter of Object.values(w.network.intersections)) {
      const connected = inter.connectedRoads ?? []
      if (connected.some((id) => barredIds.has(id)) && connected.some((id) => !barredIds.has(id))) {
        mouths.push(inter)
      }
    }
    const mouthRoads = new Set(mouths.flatMap((m) => m.connectedRoads ?? []))
    const car = Object.values(w.network.vehicles).find(
      (v) => v.type === 'car' && v.speed > 4 && mouthRoads.has(v.roadId) && !v.__staged,
    )
    if (!car) return null
    w.setRideVehicle(car.id, 'chase')
    return { id: car.id, mouths: mouths.length, barred: barredIds.size }
  })
  console.log('alley:', JSON.stringify(alleyRide))
  await page.waitForTimeout(7_000)

  // ===== 限高门架：公交进不去的那一段 ==============================
  //
  // 两辆车在布景时就放好了（见上面「布景」那段），到这一刻，公交
  // 已经停在门架下、小车跟到了它后面 —— 这一段只是把镜头切过去。
  const gantryShot = await page.evaluate((carId) => {
    const w = window.__world
    if (!carId) return null
    w.setRideVehicle(carId, 'chase')
    const v = w.network.vehicles[carId]
    return v
      ? { x: +v.position.x.toFixed(1), z: +v.position.z.toFixed(1), v: +v.speed.toFixed(1) }
      : null
  }, gantry?.car?.id ?? null)
  console.log('gantry shot:', JSON.stringify(gantryShot))
  await page.waitForTimeout(8_000)

  // 退出驾驶，回到鸟瞰收尾这一段。
  await page.evaluate(() => window.__world.setRideVehicle(null))
  await page.waitForTimeout(1_500)

  // --- 2) AI Proving Ground：加载策略并开始回放 -------------------------
  await page.goto(`${URL}/ai-playground`, { waitUntil: 'domcontentloaded' })
  await page.locator('[data-testid="list-checkpoints-button"]').click()
  await waitFor(
    page,
    () => {
      const sel = document.querySelector('[data-testid="ckpt-replay-select"] select')
      return Boolean(sel && sel.options.length > 1)
    },
    30_000,
  )
  const ckpt = await page.$eval(
    '[data-testid="ckpt-replay-select"] select',
    (el) => el.options[1].value,
  )
  console.log('replaying checkpoint:', ckpt)
  await page.selectOption('[data-testid="ckpt-replay-select"] select', ckpt)
  await page.locator('[data-testid="load-policy-button"]').click()
  await waitFor(
    page,
    () => {
      const el = document.querySelector('[data-testid="policy-status"]')
      return Boolean(el && el.textContent && el.textContent.includes('14 obs'))
    },
    60_000,
  )
  await waitFor(
    page,
    () => {
      const sel = document.querySelector('[data-testid="replay-target-select"] select')
      return Boolean(sel && sel.options.length > 1)
    },
    30_000,
  )
  await page.selectOption('[data-testid="replay-target-select"] select', 'v-1')
  await page.locator('[data-testid="start-replay-button"]').click()
  await waitFor(
    page,
    () => {
      const el = document.querySelector('[data-testid="replay-state"]')
      return Boolean(el && el.textContent && el.textContent.includes('运行中'))
    },
    30_000,
  )
  console.log('replay running')

  // --- 2) 客户端路由回 SceneLab（不能整页刷新：刷新会重置 store，策略与
  //        回放状态都活在内存里） -----------------------------------------
  // 回首页再进编辑器——用现在真实存在的导航（玻璃胶囊的 logo 回首页，
  // 场景带进 SceneLab）。客户端路由，策略与回放状态都活在内存里。
  await page.locator('.showcase-nav a[href="/"]').first().click()
  await page.waitForURL('**/', { timeout: 20_000 })
  await page.locator('.feature-band a[href="/scene-editor"]').click()
  await page.waitForURL('**/scene-editor', { timeout: 20_000 })
  await waitFor(page, () => {
    const w = window
    return Boolean(w.__world && Object.keys(w.__world.network.vehicles).length > 0)
  })

  // --- 3) 十字路口：策略开的那辆车在画面上 -----------------------------
  //
  // 多加几辆车，画面上更有车流的感觉
  await page.evaluate(() => {
    const w = window.__world
    let guard = 0
    while (Object.keys(w.network.vehicles).length < 8 && guard++ < 40) w.addVehicle()
  })
  // 用产品自带的「适配场景」把镜头框住路网（否则画面里路口只有中间一小块）
  await page.locator('[data-testid="fit-scene-button"]').click()
  await page.waitForTimeout(800)
  // 再滚轮拉近，让路口占满画面（默认俯视全景里路口太小，看不清车在动）
  await page.mouse.move(640, 400)
  for (let i = 0; i < 6; i++) {
    await page.mouse.wheel(0, -400)
    await page.waitForTimeout(200)
  }
  // 「车有没有在开」量的是**走过的路程**，不是起终点距离，也不是 `s`：
  //   - `s` 是车在**当前那条路**上的弧长，过路口或末端绕回时会重置；
  //   - 起终点距离在十字路口这种小闭环里几乎是 0（车绕回来了）。
  // 所以每 250ms 采一次位置，把位移累加成路程。
  let pathLength = 0
  let last = await page.evaluate(() => {
    const v = window.__world.network.vehicles['v-1']
    return v ? { x: v.position.x, z: v.position.z } : null
  })
  const samples = Math.ceil((SCENE_SECONDS * 1000) / 250)
  for (let i = 0; i < samples; i++) {
    await page.waitForTimeout(250)
    const now = await page.evaluate(() => {
      const v = window.__world.network.vehicles['v-1']
      return v ? { x: v.position.x, z: v.position.z } : null
    })
    if (now && last) pathLength += Math.hypot(now.x - last.x, now.z - last.z)
    if (now) last = now
  }

  const state = await page.evaluate(() => {
    const w = window.__world
    const v = w.network.vehicles['v-1']
    return {
      replayActive: w.replayActive,
      replayLast: window.__replayLast ?? null,
      fps: Math.round(w.fps),
      vehicles: Object.keys(w.network.vehicles).length,
      ego: v
        ? { x: v.position.x, z: v.position.z, speed: v.speed, targetSpeed: v.targetSpeed }
        : null,
    }
  })
  console.log('final state:', JSON.stringify(state))
  if (!state.replayActive || !state.replayLast) {
    throw new Error('the replay never ran in the 3D view — the video would be empty')
  }

  // --- 4) 切到 5×5 网格：让「RL 指挥信号灯」真的看得见 -------------------
  //
  // AI 页装上的是**网格**信号策略（6 obs / 5 act），它只装得上 5×5 网格
  // 场景（路口数与观测口径要对得上）。这一段原来停在十字路口，抽屉里写
  // 的是「RL (未实装·回退固定周期)」——**画面上看不出在跑 RL**。
  //
  // 切场景会重置网络（回放随之停下），所以这一段放在最后：前面那段先把
  // 「策略开的那辆车」拍完并断言过，再切网格拍「策略指挥的信号灯」。
  await page.selectOption('[data-testid="scene-kind-select"]', 'grid')
  await page.waitForTimeout(3500)
  // 权威判据是 store 里的 controllerKind（'rl'）；抽屉的触发按钮显示的是
  // 当前选项的文案（选项列表里始终有一项写着「RL (未实装·回退固定周期)」，
  // 所以不能拿抽屉的全文去匹配）。
  const rlSignalInstalled = await page.evaluate(() => {
    const w = window.__world
    const trigger = document.querySelector('[data-testid="controller-select"] .app-select-value')
    return {
      kind: w?.controllerKind ?? '(none)',
      label: trigger?.textContent?.trim() ?? '(none)',
      intersections: Object.keys(w?.network?.intersections ?? {}).length,
      lights: Object.values(w?.network?.intersections ?? {}).reduce(
        (n, i) => n + (i.trafficLights?.length ?? 0),
        0,
      ),
    }
  })
  console.log('signal controller:', JSON.stringify(rlSignalInstalled))
  if (rlSignalInstalled.kind !== 'rl') {
    throw new Error(
      `the RL signal policy did not install on the grid scene (${rlSignalInstalled.kind} / ${rlSignalInstalled.label})`,
    )
  }
  // 网格要看得**全**（25 个窗口），所以只拉近一点点，不钻到单个路口
  await page.locator('[data-testid="fit-scene-button"]').click()
  await page.waitForTimeout(600)
  await page.mouse.move(640, 400)
  await page.mouse.wheel(0, -160)
  await page.waitForTimeout(GRID_SECONDS * 1000)
  console.log(`ego drove ${pathLength.toFixed(1)} m`)
  if (pathLength < 50) {
    throw new Error(`the policy did not drive the ego (drove ${pathLength.toFixed(1)} m)`)
  }

  await page.close()
  await context.close()
  await browser.close()

  const produced = fs.readdirSync(TMP_DIR).filter((f) => f.endsWith('.webm'))
  if (produced.length === 0) throw new Error('no video was produced')
  fs.copyFileSync(path.join(TMP_DIR, produced[0]), OUT)
  const size = fs.statSync(OUT).size
  fs.rmSync(TMP_DIR, { recursive: true, force: true })
  console.log(`video written: ${OUT} (${(size / 1024).toFixed(0)} KB)`)
  if (errors.length) console.log('page errors seen:', JSON.stringify(errors.slice(0, 5)))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
