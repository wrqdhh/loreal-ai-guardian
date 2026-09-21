# `manifest.json`

> 源文件 `dataset/manifest.json` · 语言 `json` · 4600 字节 · 187 行

```json
{
  "version": "1.0",
  "created": "2026-09-21T03:44:51.070Z",
  "generator": "tools/make_splices.js",
  "seed": null,
  "synthetic": true,
  "labels": {
    "authentic": "真实拍摄，未经合成替换（可含美颜）",
    "ai_generated": "整幅由生成模型产出",
    "tampered": "真实底图被拼接/替换过局部区域"
  },
  "counts": {
    "authentic": 6,
    "ai_generated": 3,
    "tampered": 3
  },
  "samples": [
    {
      "id": "real_0001",
      "image": "samples/real_0001.png",
      "category": "real_original",
      "label": "authentic",
      "synthetic": true,
      "width": 900,
      "height": 700,
      "source": "dataset/raw/_demo_real/demo_real_0.png"
    },
    {
      "id": "real_0002",
      "image": "samples/real_0002.png",
      "category": "real_original",
      "label": "authentic",
      "synthetic": true,
      "width": 900,
      "height": 700,
      "source": "dataset/raw/_demo_real/demo_real_1.png"
    },
    {
      "id": "real_0003",
      "image": "samples/real_0003.png",
      "category": "real_original",
      "label": "authentic",
      "synthetic": true,
      "width": 900,
      "height": 700,
      "source": "dataset/raw/_demo_real/demo_real_2.png"
    },
    {
      "id": "ai_0004",
      "image": "samples/ai_0004.png",
      "category": "ai_plain",
      "label": "ai_generated",
      "synthetic": true,
      "width": 1024,
      "height": 1024,
      "source": "dataset/raw/_demo_ai/demo_ai_0.png"
    },
    {
      "id": "ai_0005",
      "image": "samples/ai_0005.png",
      "category": "ai_plain",
      "label": "ai_generated",
      "synthetic": true,
      "width": 1024,
      "height": 1024,
      "source": "dataset/raw/_demo_ai/demo_ai_1.png"
    },
    {
      "id": "ai_0006",
      "image": "samples/ai_0006.png",
      "category": "ai_plain",
      "label": "ai_generated",
      "synthetic": true,
      "width": 1024,
      "height": 1024,
      "source": "dataset/raw/_demo_ai/demo_ai_2.png"
    },
    {
      "id": "splice_0007",
      "image": "samples/splice_0007.png",
      "category": "splice_ai_into_real",
      "label": "tampered",
      "synthetic": true,
      "width": 900,
      "height": 700,
      "mask": "masks/splice_0007.png",
      "region": {
        "x": 23,
        "y": 202,
        "w": 227,
        "h": 228,
        "shape": "ellipse",
        "feather": 6
      },
      "donor": "demo_ai_0.png"
    },
    {
      "id": "splice_0008",
      "image": "samples/splice_0008.png",
      "category": "splice_ai_into_real",
      "label": "tampered",
      "synthetic": true,
      "width": 900,
      "height": 700,
      "mask": "masks/splice_0008.png",
      "region": {
        "x": 286,
        "y": 62,
        "w": 304,
        "h": 154,
        "shape": "ellipse",
        "feather": 6
      },
      "donor": "demo_ai_1.png"
    },
    {
      "id": "splice_0009",
      "image": "samples/splice_0009.png",
      "category": "splice_ai_into_real",
      "label": "tampered",
      "synthetic": true,
      "width": 900,
      "height": 700,
      "mask": "masks/splice_0009.png",
      "region": {
        "x": 81,
        "y": 485,
        "w": 334,
        "h": 191,
        "shape": "ellipse",
        "feather": 6
      },
      "donor": "demo_ai_2.png"
    },
    {
      "id": "retouch_0010",
      "image": "samples/retouch_0010.png",
      "category": "retouched_real",
      "label": "authentic",
      "synthetic": true,
      "width": 900,
      "height": 700,
      "note": "真实照片经美颜处理，ground truth 仍为真实，用于测量误报率",
      "region": {
        "x": 226,
        "y": 217,
        "w": 405,
        "h": 315,
        "shape": "rect"
      }
    },
    {
      "id": "retouch_0011",
      "image": "samples/retouch_0011.png",
      "category": "retouched_real",
      "label": "authentic",
      "synthetic": true,
      "width": 900,
      "height": 700,
      "note": "真实照片经美颜处理，ground truth 仍为真实，用于测量误报率",
      "region": {
        "x": 296,
        "y": 142,
        "w": 405,
        "h": 315,
        "shape": "rect"
      }
    },
    {
      "id": "retouch_0012",
      "image": "samples/retouch_0012.png",
      "category": "retouched_real",
      "label": "authentic",
      "synthetic": true,
      "width": 900,
      "height": 700,
      "note": "真实照片经美颜处理，ground truth 仍为真实，用于测量误报率",
      "region": {
        "x": 36,
        "y": 300,
        "w": 405,
        "h": 315,
        "shape": "rect"
      }
    }
  ]
}
```
