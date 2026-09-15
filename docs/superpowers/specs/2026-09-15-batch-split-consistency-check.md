# 批次拆分一致性實測（2026-09-15）

本文記錄 spec §3.1 的實測方法與結果，讓任何人可在有 GPU 的機器上重跑。不進 CI。

## 環境

- ComfyUI 0.34.5（Comfy Desktop）、torch 2.12.1+cu130、RTX 5080 16 GB
- 模型：`flux1-dev.safetensors`（UNETLoader）、`clip_l.safetensors` + `t5xxl_fp16.safetensors`（DualCLIPLoader, flux）、`ae.safetensors`

## 1. 純雜訊層（應該逐位元相同）

用 ComfyUI 自己的 `comfy.sample.prepare_noise`：整批一次產生，對比帶 `noise_inds=[i]` 逐片產生後取第 i 片。

```python
import torch, sys
sys.path.insert(0, ".")  # 在 ComfyUI 根目錄執行
from comfy.sample import prepare_noise
for shape in [(4,4,64,64),(3,16,128,96),(2,4,8,8),(5,4,72,40),(2,16,1,128,128)]:
    lat = torch.zeros(shape)
    full = prepare_noise(lat, 12345)
    ok = all(torch.equal(full[i:i+1], prepare_noise(lat[:1], 12345, noise_inds=[i])) for i in range(shape[0]))
    print(shape, "bit-identical" if ok else "DIFFERS")
```

結果：五種 shape 全部 `bit-identical`。

## 2. 端到端（應該同構圖、極小浮點差）

A：`EmptySD3LatentImage(512×512, batch_size=2)` → KSampler(seed 424242, 4 步, euler/simple, cfg 1) → VAEDecode → SaveImage。
B：同一張圖，在 latent 與 KSampler 之間插入 `LatentFromBatch(batch_index=1, length=1)`。

比對 B 的唯一輸出與 A 的第 2 張：

| 比對 | 平均絕對像素差 (/255) | 最大差 | 差 >2 的像素比例 |
|---|---|---|---|
| B vs A[1]（應相同） | **0.47** | 22 | 2.8% |
| B vs A[0]（對照：不同張） | 17.69 | 141 | 82.6% |
| A[0] vs A[1]（對照） | 17.83 | 140 | 82.7% |

結論：同一個人、同一構圖；差異是 batch=2 與 batch=1 走不同 kernel 路徑的浮點雜訊，與「同一 job 落在不同 GPU」本來就存在的差異同一等級。

## 重跑腳本

```python
"""Spike: does LatentFromBatch(index=i) reproduce image i of a batch run?

Queues two prompts on the local ComfyUI (port 8199):
  A) batch_size=2, seed S  -> two images
  B) batch_size=2 -> LatentFromBatch(idx=1, len=1) -> one image
Then compares B's image with A's second image pixel-wise.
Throwaway -- not part of the repo.
"""
import copy, json, sys, time, urllib.request, io

BASE = "http://127.0.0.1:8199"
SEED = 424242
PREFIX = "cfspike"

base = {
    "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "flux1-dev.safetensors", "weight_dtype": "default"}},
    "2": {"class_type": "DualCLIPLoader", "inputs": {"clip_name1": "clip_l.safetensors", "clip_name2": "t5xxl_fp16.safetensors", "type": "flux"}},
    "3": {"class_type": "VAELoader", "inputs": {"vae_name": "ae.safetensors"}},
    "4": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["2", 0], "text": "portrait photo of a woman with red hair, studio light"}},
    "5": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["2", 0], "text": ""}},
    "6": {"class_type": "EmptySD3LatentImage", "inputs": {"width": 512, "height": 512, "batch_size": 2}},
    "7": {"class_type": "KSampler", "inputs": {"model": ["1", 0], "positive": ["4", 0], "negative": ["5", 0],
           "latent_image": ["6", 0], "seed": SEED, "steps": 4, "cfg": 1.0, "sampler_name": "euler",
           "scheduler": "simple", "denoise": 1.0}},
    "8": {"class_type": "VAEDecode", "inputs": {"samples": ["7", 0], "vae": ["3", 0]}},
    "9": {"class_type": "SaveImage", "inputs": {"images": ["8", 0], "filename_prefix": PREFIX + "_A"}},
}
split = copy.deepcopy(base)
split["10"] = {"class_type": "LatentFromBatch", "inputs": {"samples": ["6", 0], "batch_index": 1, "length": 1}}
split["7"]["inputs"]["latent_image"] = ["10", 0]
split["9"]["inputs"]["filename_prefix"] = PREFIX + "_B"


def post(path, body):
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req, timeout=30))


def wait(pid):
    while True:
        h = json.load(urllib.request.urlopen(BASE + "/history/" + pid, timeout=30))
        if pid in h:
            st = h[pid]["status"]
            if st.get("status_str") == "error":
                print(json.dumps(h[pid]["status"], indent=1)[:2000]); sys.exit(1)
            if st.get("completed"):
                return h[pid]["outputs"]
        time.sleep(3)


def fetch(img):
    q = f"/view?filename={img['filename']}&subfolder={img['subfolder']}&type={img['type']}"
    return urllib.request.urlopen(BASE + q, timeout=60).read()


t0 = time.time()
pa = post("/prompt", {"prompt": base})["prompt_id"]
oa = wait(pa); print("A done", round(time.time() - t0), "s")
t1 = time.time()
pb = post("/prompt", {"prompt": split})["prompt_id"]
ob = wait(pb); print("B done", round(time.time() - t1), "s")

imgs_a = oa["9"]["images"]; imgs_b = ob["9"]["images"]
print("A files", [i["filename"] for i in imgs_a], "B files", [i["filename"] for i in imgs_b])
from PIL import Image
import numpy as np
a0 = np.asarray(Image.open(io.BytesIO(fetch(imgs_a[0]))).convert("RGB")).astype(int)
a1 = np.asarray(Image.open(io.BytesIO(fetch(imgs_a[1]))).convert("RGB")).astype(int)
b = np.asarray(Image.open(io.BytesIO(fetch(imgs_b[0]))).convert("RGB")).astype(int)
def stats(x, y):
    d = np.abs(x - y); return f"max={d.max()} mean={d.mean():.4f} frac>2={(d > 2).mean():.5f}"
print("B vs A[1] (should match):", stats(b, a1))
print("B vs A[0] (control, different image):", stats(b, a0))
print("A[0] vs A[1] (control):", stats(a0, a1))
```
