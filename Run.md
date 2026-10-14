# TraffSim3D 启动与运行指南

本文档说明如何启动项目的前后端，以及不同命令的效果。

---

## 前置要求

### 系统要求
- **Python**: 3.12 - 3.13（推荐 3.12）
- **Node.js**: 20.19.0+ 或 22.12.0+
- **包管理器**: `uv`（Python）、`npm`（Node.js）

### 安装 `uv`（Python 包管理器）

```bash
# Windows (PowerShell)
powershell -c "irm https://astral.sh/uv/install.ps1 | iex"

# macOS/Linux
curl -LsSf https://astral.sh/uv/install.sh | sh
```

---

## 后端启动（FastAPI）

### 1. 安装依赖

```bash
cd TraffSim3D-backend

# 基础安装（FastAPI + 开发工具，~50MB）
uv sync

# 或包含 RL 训练依赖（SB3 + PyTorch CPU，~250MB）
uv sync --extra rl
```

**依赖说明**：
- 基础安装：FastAPI、uvicorn、pydantic、gymnasium、numpy、OSM 解析库
- `--extra rl`：额外安装 stable-baselines3 和 PyTorch（用于 PPO 训练）

### 2. 启动开发服务器

#### 方式 A：热重载模式（推荐开发时使用）

```bash
uv run uvicorn app.main:app --reload --port 8000
```

**效果**：
- 启动 FastAPI 开发服务器，监听 `http://127.0.0.1:8000`
- `--reload`：代码修改后自动重启服务器
- 适用于日常开发

#### 方式 B：直接运行（简单测试）

```bash
uv run python app/main.py
```

**效果**：
- 启动 FastAPI 服务器，监听 `http://127.0.0.1:8000`
- 无热重载，修改代码后需手动重启
- 适用于快速测试

#### 方式 C：生产模式（性能测试）

```bash
uv run uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 4
```

**效果**：
- 启动 4 个 worker 进程，支持并发请求
- 监听所有网络接口（`0.0.0.0`）
- 适用于性能测试或部署

### 3. 验证服务器

```bash
curl http://localhost:8000/health
# → {"status": "ok"}
```

### 4. API 文档

启动后访问：
- Swagger UI: http://localhost:8000/docs
- ReDoc: http://localhost:8000/redoc

---

## 前端启动（Vue 3 + Vite）

### 1. 安装依赖

```bash
cd TraffSim3D-frontend
npm install
```

### 2. 启动开发服务器

```bash
npm run dev
```

**效果**：
- 启动 Vite 开发服务器，监听 `http://localhost:5173`
- 热模块替换（HMR）：代码修改后浏览器自动更新
- 代理后端 API 请求到 `http://localhost:8000`（通过 Vite 配置）

### 3. 访问应用

- **首页**: http://localhost:5173/ （展示页）
- **场景编辑器**: http://localhost:5173/scene-editor （核心功能）
- **AI 训练场**: http://localhost:5173/ai-playground （RL 训练界面）
- **地图导入**: http://localhost:5173/map-importer （OSM 导入）

### 4. 构建生产版本

```bash
npm run build
```

**效果**：
- 编译 TypeScript、压缩资源
- 输出到 `dist/` 目录
- 适用于部署

### 5. 预览生产版本

```bash
npm run preview
```

**效果**：
- 启动本地服务器，监听 `http://localhost:4173`
- 提供 `dist/` 目录的静态文件
- 用于部署前测试

---

## RL 训练命令

### CLI 训练（直接运行）

#### Dry-run 模式（默认，无 PPO，生成假数据用于 UI 演示）

```bash
cd TraffSim3D-backend
uv run python -m app.apps.rl.train 1000 --dry-run
```

**效果**：
- 运行 1000 步仿真
- 不训练 PPO，生成合成的奖励历史
- 用于测试 UI 和训练流程

#### 真实 PPO 训练（CPU）

```bash
uv sync --extra rl
uv run python -m app.apps.rl.train 10000 --device cpu
```

**效果**：
- 运行 10000 步 PPO 训练
- 使用 CPU（较慢但兼容所有硬件）
- 训练状态保存到 `/tmp/traffic_ppo_status.json`

#### 真实 PPO 训练（GPU，推荐 RTX 4050）

```bash
# 安装 GPU 版 PyTorch
uv pip uninstall torch torchvision torchaudio
uv pip install torch --index-url https://download.pytorch.org/whl/cu121

# 验证 GPU 可用
uv run python -c "import torch; print(torch.cuda.is_available())"

# 开始训练（自动检测 GPU）
uv run python -m app.apps.rl.train 300000 --device auto --n-agents 4
```

**效果**：
- 运行 30 万步 PPO 训练（日常训练配置）
- 4 个并行 agent 提高样本效率
- 自动选择 GPU（如果可用且 VRAM ≥ 2GB）
- 训练时间：RTX 4050 约 15 分钟

#### 训练参数说明

```bash
uv run python -m app.apps.rl.train [STEPS] [OPTIONS]
```

**参数**：
- `STEPS`：训练步数（默认 300000）
- `--device {auto,gpu,cpu}`：训练设备（默认 auto）
- `--n-agents N`：并行 agent 数量（默认 4）
- `--save-every N`：每 N 步保存 checkpoint（默认 5000）
- `--scene-kind {cross,corridor}`：场景类型（默认 cross）
- `--independent`：每个 agent 独立训练（默认共享策略）
- `--log-trajectories`：记录轨迹数据到 CSV
- `--dry-run`：跳过 PPO，生成假数据

**示例**：

```bash
# 最终验证训练（100 万步）
uv run python -m app.apps.rl.train 1000000 --device auto --n-agents 4

# 走廊场景训练 + 轨迹记录
uv run python -m app.apps.rl.train 300000 --scene-kind corridor --log-trajectories

# 独立多 agent 训练
uv run python -m app.apps.rl.train 300000 --independent --n-agents 4
```

### API 训练（通过 HTTP）

#### 启动训练

```bash
# Dry-run（安全，不训练 PPO）
curl -X POST http://localhost:8000/api/v1/rl/train \
  -H "Content-Type: application/json" \
  -d '{"steps": 1000, "dry_run": true, "device": "auto"}'

# 真实 PPO 训练（启动子进程，立即返回 PID）
curl -X POST http://localhost:8000/api/v1/rl/train \
  -H "Content-Type: application/json" \
  -d '{"steps": 300000, "dry_run": false, "device": "auto", "n_agents": 4}'
```

**效果**：
- 启动后台训练进程
- 返回训练进程 PID
- 训练状态持久化到 `/tmp/traffic_ppo_status.json`

#### 查询训练状态

```bash
curl http://localhost:8000/api/v1/rl/status
```

**返回示例**：

```json
{
  "running": true,
  "step": 15000,
  "episode_count": 75,
  "last_reward": 12.5,
  "reward_history": [0.1, 0.5, 1.2, ...],
  "started_at_ms": 1719374400000,
  "finished_at_ms": null,
  "reason": ""
}
```

#### 查询 GPU 能力

```bash
curl http://localhost:8000/api/v1/rl/capabilities
```

**返回示例**：

```json
{
  "torch_version": "2.12.1+cu121",
  "cuda_available": true,
  "device_count": 1,
  "device_name": "NVIDIA GeForce RTX 4050",
  "vram_gb": 6.0,
  "sb3_available": true,
  "device_fallback_reason": ""
}
```

### 轨迹数据管理

#### 列出轨迹文件

```bash
curl http://localhost:8000/api/v1/rl/trajectories
```

**返回示例**：

```json
[
  {
    "filename": "episode_000000.csv",
    "pid_dir": "pid12345",
    "size_kb": 102.5,
    "mtime_ms": 1719374400000,
    "total_episodes": 10,
    "scene_kind": "cross"
  }
]
```

#### 下载轨迹 CSV

```bash
curl http://localhost:8000/api/v1/rl/trajectories/episode_000000.csv \
  -o trajectory.csv
```

#### 清理旧轨迹

```bash
# 保留最新 20 个文件
curl -X DELETE "http://localhost:8000/api/v1/rl/trajectories?keep=20"
```

---

## 测试命令

### 后端测试

```bash
cd TraffSim3D-backend

# 运行所有测试
uv run python -m pytest

# 运行特定测试文件
uv run python -m pytest tests/test_rl_sim.py

# 详细输出
uv run python -m pytest -v

# 代码检查
uv run ruff check .

# 类型检查（严格模式）
uv run mypy app
```

**测试说明**：
- 使用 `httpx2 + ASGITransport` 进行进程内 FastAPI 测试
- 无需启动 uvicorn 子进程，每个测试 <100ms
- 测试覆盖：OSM 解析、RL 仿真、Gymnasium 环境、API 端点

### 前端测试

```bash
cd TraffSim3D-frontend

# 运行单元测试（Vitest）
npm run test

# 运行一次并退出
npm run test:run

# 运行 E2E 测试（Playwright）
npm run test:e2e

# 有头模式（显示浏览器）
npm run test:e2e:headed

# 更新截图快照
npm run test:e2e:update
```

---

## GPU / CUDA 配置

### 检查 GPU 状态

```bash
# 检查 PyTorch 是否检测到 GPU
uv run python -c "import torch; print(torch.cuda.is_available(), torch.cuda.get_device_name(0))"

# 或通过 API
curl http://localhost:8000/api/v1/rl/capabilities
```

### 安装 GPU 版 PyTorch（RTX 30/40 系列）

```bash
# 卸载 CPU 版
uv pip uninstall torch torchvision torchaudio

# 安装 CUDA 12.1 版（推荐 RTX 4050）
uv pip install torch --index-url https://download.pytorch.org/whl/cu121

# 验证
uv run python -c "import torch; print(torch.cuda.is_available())"
```

### CUDA 版本选择

| 显卡型号 | CUDA 版本 | 安装命令 |
|---------|----------|---------|
| RTX 40 系列（4050/4060/4070/4080/4090） | cu121 | `--index-url https://download.pytorch.org/whl/cu121` |
| RTX 30 系列（3050/3060/3070/3080/3090） | cu121 | `--index-url https://download.pytorch.org/whl/cu121` |
| RTX 20 系列（2060/2070/2080） | cu118 | `--index-url https://download.pytorch.org/whl/cu118` |

**注意**：每个环境只能有一个 PyTorch 安装。CPU ↔ GPU 切换需要卸载后重新安装。

---

## 常用开发工作流

### 工作流 1：日常开发（前后端联调）

```bash
# 终端 1：启动后端（热重载）
cd TraffSim3D-backend
uv run uvicorn app.main:app --reload --port 8000

# 终端 2：启动前端（HMR）
cd TraffSim3D-frontend
npm run dev

# 浏览器访问 http://localhost:5173/scene-editor
```

### 工作流 2：RL 训练实验

```bash
# 终端 1：启动后端
cd TraffSim3D-backend
uv run uvicorn app.main:app --reload --port 8000

# 终端 2：启动前端
cd TraffSim3D-frontend
npm run dev

# 终端 3：运行训练（带轨迹记录）
cd TraffSim3D-backend
uv run python -m app.apps.rl.train 300000 --device auto --n-agents 4 --log-trajectories

# 浏览器访问 http://localhost:5173/ai-playground 查看训练进度
```

### 工作流 3：自定义场景训练

```bash
# 1. 在前端编辑场景
# 浏览器访问 http://localhost:5173/scene-editor
# 添加道路、交叉口、NPC 生成器

# 2. 导出场景 JSON
# 点击"导出场景"按钮，保存为 scene.json

# 3. 启动训练（使用自定义场景）
cd TraffSim3D-backend
uv run python -m app.apps.rl.train 300000 --scene-kind custom --network @scene.json

# 或在前端 AIPlaygroundView 中选择"自定义场景"并点击"开始训练"
```

### 工作流 4：测试驱动开发

```bash
# 终端 1：运行后端测试（监听模式）
cd TraffSim3D-backend
uv run python -m pytest -v --watch

# 终端 2：运行前端测试（监听模式）
cd TraffSim3D-frontend
npm run test

# 终端 3：启动开发服务器
cd TraffSim3D-backend
uv run uvicorn app.main:app --reload --port 8000
```

---

## 环境变量

### 后端环境变量

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| `TRAFFIC_PPO_STATUS` | `/tmp/traffic_ppo_status.json` | 训练状态文件路径 |
| `TRAFFSIM_TRAJECTORY_DIR` | `/tmp/traffsim_trajectories` | 轨迹数据存储目录 |

### 前端环境变量

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| `VITE_BACKEND_URL` | （空，使用 Vite 代理） | 后端 API 地址 |

**配置方式**：在项目根目录创建 `.env` 文件：

```bash
# TraffSim3D-backend/.env
TRAFFIC_PPO_STATUS=/path/to/status.json
TRAFFSIM_TRAJECTORY_DIR=/path/to/trajectories
```

```bash
# TraffSim3D-frontend/.env
VITE_BACKEND_URL=http://localhost:8000
```

---

## 故障排查

### 后端启动失败

**问题**：`ModuleNotFoundError: No module named 'xxx'`

**解决**：
```bash
cd TraffSim3D-backend
uv sync  # 重新安装依赖
```

### 前端启动失败

**问题**：`npm ERR! Cannot find module 'xxx'`

**解决**：
```bash
cd TraffSim3D-frontend
rm -rf node_modules package-lock.json
npm install  # 重新安装依赖
```

### GPU 训练失败

**问题**：`RuntimeError: CUDA out of memory`

**解决**：
- 减少 `--n-agents`（从 4 降到 2）
- 减少 `--steps`（从 30 万降到 10 万）
- 关闭其他占用 GPU 的程序

**问题**：`torch.cuda.is_available()` 返回 `False`

**解决**：
```bash
# 检查是否安装了 GPU 版 PyTorch
uv pip list | grep torch

# 如果是 CPU 版，重新安装 GPU 版
uv pip uninstall torch torchvision torchaudio
uv pip install torch --index-url https://download.pytorch.org/whl/cu121
```

### 训练状态不更新

**问题**：`/api/v1/rl/status` 返回的 `step` 一直不变

**解决**：
- 检查训练进程是否仍在运行（`ps aux | grep train`）
- 查看训练日志输出
- 重启后端服务器和训练进程

---

## 项目结构

```
TraffSim3D/
├── TraffSim3D-backend/
│   ├── app/
│   │   ├── main.py              # FastAPI 入口
│   │   ├── api/v1/              # API 端点
│   │   │   ├── rl.py            # RL 训练 API
│   │   │   └── maps.py          # OSM 解析 API
│   │   └── apps/
│   │       ├── rl/              # RL 训练模块
│   │       │   ├── sim_core.py  # 仿真核心（cross/corridor）
│   │       │   ├── network_sim_core.py  # 通用路网仿真
│   │       │   ├── env.py       # Gymnasium 环境
│   │       │   ├── train.py     # PPO 训练入口
│   │       │   ├── idm.py       # IDM 跟驰模型
│   │       │   └── trajectory.py # 轨迹记录
│   │       └── maps/            # 地图解析模块
│   ├── tests/                   # 测试文件
│   └── pyproject.toml           # Python 依赖
├── TraffSim3D-frontend/
│   ├── src/
│   │   ├── interfaces/views/    # Vue 页面
│   │   │   ├── AIPlaygroundView.vue  # RL 训练界面
│   │   │   └── MapImporterView.vue   # OSM 导入界面
│   │   └── infrastructure/api/  # API 客户端
│   ├── package.json             # Node.js 依赖
│   └── vite.config.ts           # Vite 配置
└── Run.md                       # 本文档
```

---

## 参考链接

- **FastAPI 文档**: https://fastapi.tiangolo.com/
- **Vite 文档**: https://vitejs.dev/
- **Stable-Baselines3 文档**: https://stable-baselines3.readthedocs.io/
- **PyTorch 安装**: https://pytorch.org/get-started/locally/
- **OSM 数据**: https://www.openstreetmap.org/
- **Geofabrik 下载**: https://download.geofabrik.de/asia/china.html
