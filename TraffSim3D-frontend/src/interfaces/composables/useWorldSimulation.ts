import { onBeforeUnmount, ref, watch, type Ref } from 'vue'
import { ThreeJSRenderer } from '@infrastructure/rendering'
import { useWorldStore } from '@interfaces/stores/worldStore'
import { useSelectionStore } from '@interfaces/stores/selectionStore'
import { RapierWorld, buildRigidBodySpec } from '@infrastructure/physics'
import { LidarSensor, defaultLidarConfig } from '@infrastructure/sensors'
import { LIDAR_MOUNT_HEIGHT } from '@shared/constants/simulation'
import { setMainRenderer } from './rendererRegistry'

let sharedRapierWorld: RapierWorld | null = null
let rapierInitPromise: Promise<RapierWorld> | null = null

/** Lazily create + init the Rapier world singleton. Called from
 *  useWorldSimulation. One world per page lifetime; HMR
 *  destroys on dispose (R7). */
export const getOrCreateRapierWorld = async (): Promise<RapierWorld> => {
  if (sharedRapierWorld) return sharedRapierWorld
  if (!rapierInitPromise) {
    const w = new RapierWorld()
    rapierInitPromise = w.init().then(() => {
      sharedRapierWorld = w
      return w
    })
  }
  return rapierInitPromise
}

export const destroySharedRapierWorld = (): void => {
  if (sharedRapierWorld) {
    sharedRapierWorld.destroy()
    sharedRapierWorld = null
  }
  rapierInitPromise = null
}

// HMR teardown (R7) — Vite dispose callback runs on module reload.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    destroySharedRapierWorld()
  })
}

export const useWorldSimulation = (canvasRef: Ref<HTMLCanvasElement | null>) => {
  const store = useWorldStore()
  const selection = useSelectionStore()
  const isReady = ref(false)
  const rapierReady = ref(false)
  let renderer: ThreeJSRenderer | null = null
  let resizeObserver: ResizeObserver | null = null
  let rapierWorld: RapierWorld | null = null

  const setupRenderer = async (canvas: HTMLCanvasElement) => {
    // Create the renderer immediately so the camera sensor and scene
    // visualization work even if Rapier WASM fails to load.
    renderer = new ThreeJSRenderer(canvas, { onTick: store.step })
    setMainRenderer(renderer)
    renderer.setNetworkGetter(store.getNetwork)
    renderer.setSelectionGetter(() => {
      if (selection.kind && selection.id) {
        return { kind: selection.kind, id: selection.id }
      }
      return null
    })
    renderer.setTickPolicyGetter(() => ({
      paused: !store.isRunning,
      rate: store.tickRate,
    }))
    // The first-person camera and the route ribbon are read every
    // frame: the camera rides with the follower, and the ribbon is
    // rebuilt whenever the planned route changes.
    renderer.setFollowTargetGetter(() => store.followCameraTarget())
    renderer.setRouteGetter(() => store.routeRenderPath())
    // The POI markers: the store owns the list, the renderer draws it.
    renderer.setPois(store.pois)
    renderer.start()

    const container = canvas.parentElement
    if (container) {
      renderer.resize(container.clientWidth, container.clientHeight)
      resizeObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const { width, height } = entry.contentRect
          renderer?.resize(width, height)
        }
      })
      resizeObserver.observe(container)
    }
    isReady.value = true

    // Init Rapier after the renderer is running. If WASM loading fails
    // the scene still renders; physics just won't advance.
    try {
      rapierWorld = await getOrCreateRapierWorld()
      rapierReady.value = true
      for (const v of Object.values(store.getNetwork().vehicles)) {
        rapierWorld.registerVehicle(buildRigidBodySpec(v.id, v.type, v.position, v.heading))
        const colliderHandle = rapierWorld.getColliderHandle(v.id)
        const excludes = colliderHandle ? [colliderHandle] : []
        const sensor = new LidarSensor(defaultLidarConfig(v.id, excludes))
        sensor.configure({ mountHeight: LIDAR_MOUNT_HEIGHT[v.type] })
        store.sensorRegistry.register(v.id, sensor, `lidar-${v.id}`)
      }
      store.setRapierWorld(rapierWorld)
    } catch {
      console.warn('[useWorldSimulation] Rapier init failed — physics disabled')
    }

    watch(
      () => store.lidarCloudsEnabled,
      (enabled) => {
        if (!renderer) return
        const clouds = store.getLidarPointClouds()
        if (enabled) {
          for (const v of Object.values(store.getNetwork().vehicles)) {
            const cloud = store.ensureLidarCloud(v.id)
            if (!cloud.mesh.parent) renderer.addAuxiliary(cloud.mesh)
          }
        } else {
          for (const cloud of clouds.values()) {
            renderer.removeAuxiliary(cloud.mesh)
          }
        }
      },
    )

    watch(
      () => store.pois,
      (pois) => {
        renderer?.setPois(pois)
      },
    )

    watch(
      () => store.poiSelectedId,
      (id) => {
        renderer?.selectPoi(id)
      },
    )

    watch(
      () => Object.keys(store.getNetwork().vehicles).length,
      () => {
        if (!renderer || !store.lidarCloudsEnabled) return
        for (const [id, cloud] of store.getLidarPointClouds()) {
          if (!cloud.mesh.parent) renderer.addAuxiliary(cloud.mesh)
        }
      },
    )
  }

  watch(
    canvasRef,
    (canvas) => {
      if (canvas) void setupRenderer(canvas)
    },
    { immediate: true },
  )

  // Camera sensor creation — top-level so it doesn't depend
  // on Rapier loading (setupRenderer awaits Rapier before returning).
  watch(
    () => store.cameraEnabled,
    (enabled) => {
      if (!enabled) return
      if (store.getCameraSensor()) return
      const hostId =
        selection.kind === 'vehicle' && selection.id
          ? selection.id
          : (Object.keys(store.getNetwork().vehicles)[0] ?? 'v-1')
      store.initCameraSensor(hostId)
    },
  )

  onBeforeUnmount(() => {
    renderer?.dispose()
    renderer = null
    setMainRenderer(null)
    resizeObserver?.disconnect()
    resizeObserver = null
    // Note: do NOT destroy the shared RapierWorld here. HMR might
    // re-mount the same composable. HMR disposal goes through
    // import.meta.hot.dispose above.
    rapierWorld = null
  })

  const getRenderer = (): ThreeJSRenderer | null => renderer
  return { isReady, rapierReady, store, getRenderer }
}
