<template>
  <canvas ref="canvasRef" class="webgl-background"></canvas>
</template>

<script setup name="EnhancedWebGLBackground">
import { onMounted, onUnmounted, ref } from 'vue';
import * as THREE from 'three';
import {
  EffectComposer,
  RenderPass,
  EffectPass,
  BloomEffect,
  VignetteEffect,
  ChromaticAberrationEffect,
  NoiseEffect
} from "postprocessing";

const canvasRef = ref(null);
let scene, camera, renderer, composer;
let particlesBackground, particlesMidground, particlesForeground; // 新增：中景粒子
let gridMesh;
let pointLight; // 新增：动态点光源
let mouseX = 0, mouseY = 0;
let scrollY = 0; // 新增：响应滚动
let isHighPerformance = true; // 新增：性能检测标志
let lastFrameTime = 0;
let frameCount = 0;
let fps = 60; // 新增：帧率监控

// 着色器 - 背景粒子（原）
const backgroundVertexShader = `
  attribute vec3 a_position;
  attribute float size;
  attribute vec3 color;

  uniform float u_time;
  varying vec3 vColor;

  void main() {
    vColor = color;
    vec3 newPosition = a_position;

    // 粒子缓慢流动
    newPosition.x += sin(newPosition.y * 0.1 + u_time * 0.05) * 5.0;
    newPosition.y += cos(newPosition.x * 0.1 + u_time * 0.05) * 5.0;

    vec4 mvPosition = modelViewMatrix * vec4(newPosition, 1.0);
    gl_PointSize = size * (200.0 / -mvPosition.z);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

// 新增：中景粒子着色器（中等速度流动，添加轻微扭曲）
const midgroundVertexShader = `
  attribute vec3 a_position;
  attribute float size;
  attribute vec3 color;

  uniform float u_time;
  uniform float u_scroll;
  varying vec3 vColor;

  void main() {
    vColor = color;
    vec3 newPosition = a_position;

    // 中等流动 + 滚动偏移
    newPosition.x += sin(newPosition.z * 0.2 + u_time * 0.1) * 8.0 + u_scroll * 0.5;
    newPosition.y += cos(newPosition.z * 0.2 + u_time * 0.1) * 8.0;
    newPosition.z += sin(newPosition.x * 0.1 + u_time * 0.05) * 5.0; // 轻微扭曲

    vec4 mvPosition = modelViewMatrix * vec4(newPosition, 1.0);
    gl_PointSize = size * (250.0 / -mvPosition.z);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

// 着色器 - 前景粒子（原，添加滚动影响）
const foregroundVertexShader = `
  attribute vec3 a_position;
  attribute float size;
  attribute vec3 color;

  uniform float u_time;
  uniform vec2 u_mouse;
  uniform float u_scroll; // 新增：滚动偏移
  varying vec3 vColor;

  void main() {
    vColor = color;
    vec3 newPosition = a_position;

    // 粒子快速运动
    newPosition.x += sin(newPosition.y * 0.5 + u_time) * 10.0;
    newPosition.y += cos(newPosition.x * 0.5 + u_time) * 10.0 + u_scroll;

    // 鼠标交互，推开粒子
    vec2 mouseOffset = vec2(a_position.x - u_mouse.x * 250.0, a_position.y - u_mouse.y * 250.0);
    float dist = length(mouseOffset);
    if (dist < 100.0) {
        newPosition.z += (1.0 - dist / 100.0) * 100.0;
    }

    vec4 mvPosition = modelViewMatrix * vec4(newPosition, 1.0);
    gl_PointSize = size * (300.0 / -mvPosition.z);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

// 着色器 - 共同的片元着色器（原，添加光照影响）
const fragmentShader = `
  varying vec3 vColor;
  uniform vec3 u_lightColor; // 新增：光源颜色影响

  void main() {
    float strength = distance(gl_PointCoord, vec2(0.5));
    strength = 1.0 - strength;
    vec3 finalColor = vColor * strength * u_lightColor; // 乘以光源颜色
    gl_FragColor = vec4(finalColor, strength);
  }
`;

// 新增：节流函数，减少事件触发频率
function throttle(fn, delay) {
  let lastCall = 0;
  return function (...args) {
    const now = Date.now();
    if (now - lastCall >= delay) {
      lastCall = now;
      fn(...args);
    }
  };
}

function init() {
  // 新增：性能检测（初始帧率粗估）
  const perfTestStart = performance.now();
  for (let i = 0; i < 100; i++) { Math.sin(i); } // 简单测试
  const perfTestEnd = performance.now();
  isHighPerformance = (perfTestEnd - perfTestStart) < 1; // 如果测试快，认为是高性能设备

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
  camera.position.z = 250;

  renderer = new THREE.WebGLRenderer({
    canvas: canvasRef.value,
    antialias: true,
    alpha: true,
  });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(window.devicePixelRatio);

  // 新增：动态调整粒子数量基于性能
  let bgParticleCount = isHighPerformance ? 30000 : 15000;
  let mgParticleCount = isHighPerformance ? 10000 : 5000; // 新增中景
  let fgParticleCount = isHighPerformance ? 5000 : 2500;

  // 创建背景粒子（原，调整数量）
  const bgPositions = new Float32Array(bgParticleCount * 3);
  const bgSizes = new Float32Array(bgParticleCount);
  const bgColors = new Float32Array(bgParticleCount * 3);

  for (let i = 0; i < bgParticleCount; i++) {
    bgPositions[i * 3 + 0] = (Math.random() - 0.5) * 800;
    bgPositions[i * 3 + 1] = (Math.random() - 0.5) * 800;
    bgPositions[i * 3 + 2] = (Math.random() - 0.5) * 800;
    bgSizes[i] = Math.random() * 2 + 1;
    const color = new THREE.Color();
    color.setHSL(Math.random() * 0.2 + 0.6, 0.8, 0.5);
    bgColors[i * 3 + 0] = color.r;
    bgColors[i * 3 + 1] = color.g;
    bgColors[i * 3 + 2] = color.b;
  }

  const bgGeometry = new THREE.BufferGeometry();
  bgGeometry.setAttribute('a_position', new THREE.BufferAttribute(bgPositions, 3));
  bgGeometry.setAttribute('size', new THREE.BufferAttribute(bgSizes, 1));
  bgGeometry.setAttribute('color', new THREE.BufferAttribute(bgColors, 3));

  const bgMaterial = new THREE.ShaderMaterial({
    uniforms: {
      u_time: { value: 0.0 },
      u_lightColor: { value: new THREE.Vector3(1, 1, 1) } // 新增
    },
    vertexShader: backgroundVertexShader,
    fragmentShader: fragmentShader,
    blending: THREE.AdditiveBlending,
    transparent: true,
  });
  particlesBackground = new THREE.Points(bgGeometry, bgMaterial);
  scene.add(particlesBackground);

  // 新增：创建中景粒子
  const mgPositions = new Float32Array(mgParticleCount * 3);
  const mgSizes = new Float32Array(mgParticleCount);
  const mgColors = new Float32Array(mgParticleCount * 3);

  for (let i = 0; i < mgParticleCount; i++) {
    mgPositions[i * 3 + 0] = (Math.random() - 0.5) * 600;
    mgPositions[i * 3 + 1] = (Math.random() - 0.5) * 600;
    mgPositions[i * 3 + 2] = (Math.random() - 0.5) * 600;
    mgSizes[i] = Math.random() * 3 + 2;
    const color = new THREE.Color();
    color.setHSL(Math.random() * 0.1 + 0.7, 0.9, 0.6);
    mgColors[i * 3 + 0] = color.r;
    mgColors[i * 3 + 1] = color.g;
    mgColors[i * 3 + 2] = color.b;
  }

  const mgGeometry = new THREE.BufferGeometry();
  mgGeometry.setAttribute('a_position', new THREE.BufferAttribute(mgPositions, 3));
  mgGeometry.setAttribute('size', new THREE.BufferAttribute(mgSizes, 1));
  mgGeometry.setAttribute('color', new THREE.BufferAttribute(mgColors, 3));

  const mgMaterial = new THREE.ShaderMaterial({
    uniforms: {
      u_time: { value: 0.0 },
      u_scroll: { value: 0.0 },
      u_lightColor: { value: new THREE.Vector3(1, 1, 1) } // 新增
    },
    vertexShader: midgroundVertexShader,
    fragmentShader: fragmentShader,
    blending: THREE.AdditiveBlending,
    transparent: true,
  });
  particlesMidground = new THREE.Points(mgGeometry, mgMaterial);
  scene.add(particlesMidground);

  // 创建前景粒子（原，调整数量）
  const fgPositions = new Float32Array(fgParticleCount * 3);
  const fgSizes = new Float32Array(fgParticleCount);
  const fgColors = new Float32Array(fgParticleCount * 3);

  for (let i = 0; i < fgParticleCount; i++) {
    fgPositions[i * 3 + 0] = (Math.random() - 0.5) * 400;
    fgPositions[i * 3 + 1] = (Math.random() - 0.5) * 400;
    fgPositions[i * 3 + 2] = (Math.random() - 0.5) * 400;
    fgSizes[i] = Math.random() * 5 + 3;
    const color = new THREE.Color();
    color.setHSL(Math.random() * 0.2 + 0.5, 1.0, 0.8);
    fgColors[i * 3 + 0] = color.r;
    fgColors[i * 3 + 1] = color.g;
    fgColors[i * 3 + 2] = color.b;
  }

  const fgGeometry = new THREE.BufferGeometry();
  fgGeometry.setAttribute('a_position', new THREE.BufferAttribute(fgPositions, 3));
  fgGeometry.setAttribute('size', new THREE.BufferAttribute(fgSizes, 1));
  fgGeometry.setAttribute('color', new THREE.BufferAttribute(fgColors, 3));

  const fgMaterial = new THREE.ShaderMaterial({
    uniforms: {
      u_time: { value: 0.0 },
      u_mouse: { value: new THREE.Vector2() },
      u_scroll: { value: 0.0 }, // 新增
      u_lightColor: { value: new THREE.Vector3(1, 1, 1) } // 新增
    },
    vertexShader: foregroundVertexShader,
    fragmentShader: fragmentShader,
    blending: THREE.AdditiveBlending,
    transparent: true,
  });
  particlesForeground = new THREE.Points(fgGeometry, fgMaterial);
  scene.add(particlesForeground);

  // 添加动态线框网格（原）
  const gridGeometry = new THREE.IcosahedronGeometry(200, 3);
  const gridMaterial = new THREE.MeshBasicMaterial({
    color: 0x00ffff,
    wireframe: true,
    transparent: true,
    opacity: 0.1,
  });
  gridMesh = new THREE.Mesh(gridGeometry, gridMaterial);
  scene.add(gridMesh);

  // 新增：动态点光源
  pointLight = new THREE.PointLight(0xffffff, 1, 500);
  pointLight.position.set(0, 0, 250);
  scene.add(pointLight);

  // 配置后处理效果（原，条件禁用chromatic aberration）
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  const bloomEffect = new BloomEffect({
    luminanceThreshold: 0.5,
    luminanceSmoothing: 0.1,
    intensity: 1.5,
  });

  const noiseEffect = new NoiseEffect({ premultiply: true });
  noiseEffect.blendMode.opacity.value = 0.05;

  const effectPass = new EffectPass(camera, bloomEffect, noiseEffect);
  if (isHighPerformance) {
    const chromaticAberrationEffect = new ChromaticAberrationEffect({
      offset: new THREE.Vector2(0.001, 0.001),
    });
    effectPass.effects.push(chromaticAberrationEffect); // 仅高性能启用
  }
  composer.addPass(effectPass);

  // 绑定事件（使用节流）
  window.addEventListener('resize', onResize);
  window.addEventListener('mousemove', throttle(onMouseMove, 16)); // 约60fps
  window.addEventListener('scroll', throttle(onScroll, 50)); // 新增滚动事件，节流50ms
  animate();
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  if (composer) {
    composer.setSize(window.innerWidth, window.innerHeight);
  }
}

function onMouseMove(event) {
  mouseX = (event.clientX / window.innerWidth) * 2 - 1;
  mouseY = -(event.clientY / window.innerHeight) * 2 + 1;
}

function onScroll() {
  scrollY = window.scrollY / window.innerHeight; // 归一化
}

function animate(timestamp) {
  requestAnimationFrame(animate);

  // 新增：帧率监控，每60帧检查一次
  frameCount++;
  if (timestamp - lastFrameTime > 1000) {
    fps = frameCount;
    frameCount = 0;
    lastFrameTime = timestamp;
    if (fps < 30 && isHighPerformance) {
      isHighPerformance = false; // 动态降级
      // 可进一步减少粒子，但需重初始化（这里简化）
    }
  }

  const time = timestamp / 1000;
  if (particlesBackground && particlesBackground.material &&
      particlesMidground && particlesMidground.material &&
      particlesForeground && particlesForeground.material) {
    particlesBackground.material.uniforms.u_time.value = time;
    particlesMidground.material.uniforms.u_time.value = time;
    particlesMidground.material.uniforms.u_scroll.value = scrollY;
    particlesForeground.material.uniforms.u_time.value = time;
    particlesForeground.material.uniforms.u_mouse.value.x = mouseX;
    particlesForeground.material.uniforms.u_mouse.value.y = mouseY;
    particlesForeground.material.uniforms.u_scroll.value = scrollY;

    // 新增：更新光源颜色和位置
    const lightColor = new THREE.Color().setHSL(time * 0.05 % 1, 0.8, 0.5);
    pointLight.color = lightColor;
    pointLight.position.x = Math.sin(time * 0.2) * 100;
    pointLight.position.y = Math.cos(time * 0.2) * 100;
    particlesBackground.material.uniforms.u_lightColor.value = new THREE.Vector3(lightColor.r, lightColor.g, lightColor.b);
    particlesMidground.material.uniforms.u_lightColor.value = new THREE.Vector3(lightColor.r, lightColor.g, lightColor.b);
    particlesForeground.material.uniforms.u_lightColor.value = new THREE.Vector3(lightColor.r, lightColor.g, lightColor.b);
  }

  if (gridMesh) {
    gridMesh.rotation.y += 0.0005;
    gridMesh.rotation.x += 0.0002;
  }

  composer.render();
}

onMounted(() => {
  init();
});

onUnmounted(() => {
  window.removeEventListener('resize', onResize);
  window.removeEventListener('mousemove', onMouseMove);
  window.removeEventListener('scroll', onScroll);
  if (renderer) {
    renderer.dispose();
  }
  if (particlesBackground) {
    particlesBackground.geometry.dispose();
    particlesBackground.material.dispose();
  }
  if (particlesMidground) { // 新增清理
    particlesMidground.geometry.dispose();
    particlesMidground.material.dispose();
  }
  if (particlesForeground) {
    particlesForeground.geometry.dispose();
    particlesForeground.material.dispose();
  }
  if (gridMesh) {
    gridMesh.geometry.dispose();
    gridMesh.material.dispose();
  }
  if (pointLight) { // 新增清理
    pointLight.dispose();
  }
  if (composer) {
    composer.dispose();
  }
});
</script>

<style scoped>
.webgl-background {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  z-index: -1;
  pointer-events: none;
}
</style>
