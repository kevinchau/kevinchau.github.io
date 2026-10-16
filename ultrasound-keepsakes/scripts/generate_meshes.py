#!/usr/bin/env python3
"""Run the official pretrained TripoSR locally on explicitly illustrated inputs.

The inputs are AI-generated concept images, NOT ultrasound volume data. These
meshes are artistic interpretations and cannot establish anatomy, identity,
physical measurements, medical findings, or appearance at a future age.

Setup (inspect upstream source before installing):
  git clone https://github.com/VAST-AI-Research/TripoSR.git .work/triposr/repo
  git -C .work/triposr/repo checkout 107cefdc244c39106fa830359024f6a2f1c78871
  uv venv --python 3.11 .work/triposr/venv
  uv pip install --python .work/triposr/venv/bin/python -r scripts/mesh-requirements.txt
  git clone https://github.com/tatsy/torchmcubes.git .work/triposr/torchmcubes
  git -C .work/triposr/torchmcubes checkout 879926d0ef58e6ce0ac2630fdecb5e53af7ed3ff
  uv pip install --python .work/triposr/venv/bin/python --no-build-isolation .work/triposr/torchmcubes
  .work/triposr/venv/bin/python scripts/generate_meshes.py --device mps

Only public model weights/configuration are downloaded. Inputs stay local.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import importlib.metadata
import json
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / ".work/triposr"
REPO_REVISION = "107cefdc244c39106fa830359024f6a2f1c78871"
MODEL_REVISION = "5b521936b01fbe1890f6f9baed0254ab6351c04a"
DINO_REVISION = "f205d5d8e640a89a2b8ef0369670dfc37cc07fc2"
MC_REVISION = "879926d0ef58e6ce0ac2630fdecb5e53af7ed3ff"
MODEL_SHA256 = "429e2c6b22a0923967459de24d67f05962b235f79cde6b032aa7ed2ffcd970ee"
LIMITATION = (
    "Illustrative AI concept generated from an artistically imagined image. "
    "Not a reconstruction of fetal anatomy, not an identity likeness, not an "
    "age progression prediction, and not suitable for diagnosis or measurement. "
    "Hidden surfaces are inferred by a generic object model. Units are arbitrary."
)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def note(message: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {message}", flush=True)


def weld_numerical_seams(mesh, tolerance=1e-6):
    """Weld duplicate float32 edge vertices within 1/9000 of a grid cell.

    Native marching cubes computes shared edge vertices independently, sometimes
    differing by one float32 ULP. A spatial weld avoids rounding-cell boundaries
    and does not fill holes, smooth, remesh, or add faces.
    """
    import numpy as np
    from scipy.spatial import cKDTree

    parents = np.arange(len(mesh.vertices))

    def root(index):
        while parents[index] != index:
            parents[index] = parents[parents[index]]
            index = parents[index]
        return index

    for first, second in cKDTree(mesh.vertices).query_pairs(tolerance, output_type="ndarray"):
        parents[root(second)] = root(first)
    groups = np.array([root(index) for index in range(len(parents))])
    keep, inverse = np.unique(groups, return_inverse=True)
    welded = len(parents) - len(keep)
    face_count = len(mesh.faces)
    mesh.update_vertices(keep, inverse=inverse)
    mesh.update_faces(mesh.nondegenerate_faces())
    mesh.remove_unreferenced_vertices()
    return welded, face_count - len(mesh.faces)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--device", choices=["auto", "mps", "cpu"], default="auto")
    parser.add_argument("--resolution", type=int, default=192)
    parser.add_argument("--chunk-size", type=int, default=8192)
    parser.add_argument("--threads", type=int, default=6)
    parser.add_argument("--input", action="append", metavar="NAME=PATH",
                        help="Repeat to override default concept image inputs.")
    parser.add_argument("--output-dir", type=Path, default=ROOT / "output/models")
    parser.add_argument("--report", type=Path, default=ROOT / "output/pipeline-report.json")
    args = parser.parse_args()
    if not 64 <= args.resolution <= 384:
        parser.error("Resolution must be between 64 and 384.")

    import numpy as np
    import torch
    import trimesh
    from PIL import Image
    from huggingface_hub import hf_hub_download
    from omegaconf import OmegaConf

    torch.set_num_threads(args.threads)
    torch.set_num_interop_threads(min(args.threads, 4))
    torch.manual_seed(0)
    np.random.seed(0)
    device = args.device
    if device == "auto":
        device = "mps" if torch.backends.mps.is_available() else "cpu"
    if device == "mps" and not torch.backends.mps.is_available():
        raise RuntimeError("MPS requested but not available; rerun with --device cpu.")
    actual_revision = subprocess.check_output(
        ["git", "-C", str(WORK / "repo"), "rev-parse", "HEAD"], text=True
    ).strip()
    if actual_revision != REPO_REVISION:
        raise RuntimeError(f"Expected reviewed TripoSR revision {REPO_REVISION}; got {actual_revision}.")

    weights = WORK / "weights"
    weights.mkdir(parents=True, exist_ok=True)
    def verified_download(repo_id, filename, revision, destination, expected_hash):
        local = destination / filename
        if not local.exists():
            hf_hub_download(repo_id, filename, revision=revision,
                            local_dir=str(destination), local_dir_use_symlinks=False)
        if sha256(local) != expected_hash:
            raise RuntimeError(f"Checksum mismatch for {local}; remove and download the pinned file again.")
        return str(local)

    verified_download("stabilityai/TripoSR", "config.yaml", MODEL_REVISION, weights,
                      "74ca708ce086bf68e97709ea6b3d91f14717921c04691e84043f0eb8fcc68e62")
    verified_download("stabilityai/TripoSR", "model.ckpt", MODEL_REVISION, weights, MODEL_SHA256)
    dino_config = verified_download(
        "facebook/dino-vitb16", "config.json", DINO_REVISION, WORK / "dino",
        "b87c0270b97db085fd82cf114a761fd0f62ae7914fbd407c752a2260646b689c",
    )

    # Upstream only uses torchmcubes for the density-field isosurface. The model
    # inference remains unchanged. Native torchmcubes compiles on this Mac but
    # cannot consume MPS tensors, so move this one operation to CPU explicitly.
    from torchmcubes import marching_cubes as native_marching_cubes

    sys.path.insert(0, str(WORK / "repo"))
    from tsr.system import TSR
    import tsr.models.isosurface as isosurface
    import tsr.models.tokenizers.image as tokenizer
    from tsr.utils import resize_foreground, to_gradio_3d_orientation

    def cpu_marching_cubes(volume, threshold):
        return native_marching_cubes(volume.detach().cpu().contiguous(), threshold)

    isosurface.marching_cubes = cpu_marching_cubes

    def pinned_dino_config(repo_id, filename, **kwargs):
        if repo_id != "facebook/dino-vitb16" or filename != "config.json":
            raise ValueError("Unexpected tokenizer download request.")
        return dino_config

    tokenizer.hf_hub_download = pinned_dino_config
    note(f"Loading official TripoSR on {device}; all inference is local")
    started = time.monotonic()
    config = OmegaConf.load(weights / "config.yaml")
    OmegaConf.resolve(config)
    model = TSR(config)
    checkpoint = torch.load(weights / "model.ckpt", map_location="cpu", weights_only=True)
    model.load_state_dict(checkpoint, strict=True)
    del checkpoint
    model.eval().to(device)
    model.renderer.set_chunk_size(args.chunk_size)
    note(f"Model ready ({time.monotonic() - started:.1f}s)")

    inputs = args.input or [
        "prenatal=" + str(ROOT / "output/imagegen/prenatal-concept.png"),
        "age-one=" + str(ROOT / "output/imagegen/age-one-concept.png"),
    ]
    output = args.output_dir.resolve()
    output.mkdir(parents=True, exist_ok=True)
    report = {
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "purpose": "Illustrative keepsake concepts; not medical reconstructions or predictions",
        "limitation": LIMITATION,
        "model": {
            "name": "TripoSR", "repository": "https://github.com/VAST-AI-Research/TripoSR",
            "code_revision": REPO_REVISION, "weights": "https://huggingface.co/stabilityai/TripoSR",
            "weights_revision": MODEL_REVISION, "weights_sha256": MODEL_SHA256,
            "license": "MIT (official code and pretrained weights)",
            "dino_configuration_revision": DINO_REVISION,
        },
        "environment": {
            "platform": platform.platform(), "python": platform.python_version(),
            "torch": torch.__version__, "device": device, "threads": args.threads,
            "packages": {package: importlib.metadata.version(package) for package in [
                "transformers", "huggingface-hub", "omegaconf", "trimesh", "numpy", "Pillow"
            ]},
        },
        "parameters": {"mesh_grid_resolution": args.resolution, "density_threshold": 25.0,
                       "chunk_size": args.chunk_size, "foreground_ratio": 0.85, "seed": 0,
                       "numerical_seam_weld_tolerance": 1e-6},
        "adaptations": [
            "Wrapper selects Apple MPS explicitly; upstream run.py forces CPU when CUDA is absent.",
            "Use pinned DINO configuration and safe weights_only=True state-dictionary loading.",
            "Native torchmcubes compiled from reviewed revision " + MC_REVISION +
            "; density field is copied to CPU for its marching-cubes operation.",
            "Apply upstream to_gradio_3d_orientation followed by 180 degrees about Y, "
            "visually verified to put the face toward +Z and the top of the head toward +Y; units remain arbitrary.",
            "GLB includes computed smooth vertex normals, vertex colors and explicit "
            "matte PBR material (metallicFactor 0, roughnessFactor 0.9).",
            "Weld vertices within 1e-6 arbitrary units to close native float32 marching-cubes seams; "
            "remove resulting zero-area faces. No new faces are created.",
            "No texture baking, remeshing, smoothing, anatomical fitting, or procedural replacement geometry.",
        ],
        "run_command": ".work/triposr/venv/bin/python scripts/generate_meshes.py "
                       f"--device {device} --resolution {args.resolution} --chunk-size {args.chunk_size}",
        "models": [],
    }

    for spec in inputs:
        name, filename = spec.split("=", 1)
        if name not in {"prenatal", "age-one"}:
            raise ValueError("Concept name must be prenatal or age-one.")
        path = Path(filename).resolve()
        image = Image.open(path)
        if image.mode != "RGBA" or image.getextrema()[3][0] == 255:
            raise ValueError(f"{path} must have a genuine transparent background for reproducible isolation.")
        image = resize_foreground(image, 0.85)
        rgba = np.asarray(image, dtype=np.float32) / 255.0
        rgb = rgba[..., :3] * rgba[..., 3:4] + (1.0 - rgba[..., 3:4]) * 0.5
        image = Image.fromarray((rgb * 255).astype(np.uint8))
        intermediate = WORK / "intermediates" / name
        intermediate.mkdir(parents=True, exist_ok=True)
        image.save(intermediate / "model-input.png")
        note(f"{name}: image-to-triplane neural inference")
        started = time.monotonic()
        with torch.inference_mode():
            scene_codes = model([image], device=device)
        if device == "mps":
            torch.mps.synchronize()
        inference_seconds = time.monotonic() - started
        torch.save(scene_codes.detach().cpu(), intermediate / "scene-codes.pt")
        note(f"{name}: inference {inference_seconds:.1f}s; extracting {args.resolution}³ density field")
        started = time.monotonic()
        with torch.inference_mode():
            mesh = model.extract_mesh(scene_codes, has_vertex_color=True, resolution=args.resolution)[0]
        extraction_seconds = time.monotonic() - started
        mesh.export(intermediate / "raw-mesh.ply")
        if len(mesh.vertices) == 0 or len(mesh.faces) == 0 or not np.isfinite(mesh.vertices).all():
            raise RuntimeError("Model produced empty or non-finite geometry.")
        raw_faces = len(mesh.faces)
        welded_vertices, degenerate_faces_removed = weld_numerical_seams(mesh)
        faces_before_fragment_removal = len(mesh.faces)
        # Remove only tiny disconnected fragments, retaining all components with
        # at least 0.5% of total faces. Record every dropped face explicitly.
        components = trimesh.graph.connected_components(mesh.face_adjacency, nodes=np.arange(len(mesh.faces)))
        keep = np.concatenate([part for part in components if len(part) >= max(4, raw_faces * .005)])
        if len(keep) < raw_faces:
            mesh = mesh.submesh([keep], append=True)
        mesh.fix_normals(multibody=True)
        mesh = to_gradio_3d_orientation(mesh)
        mesh.apply_transform(trimesh.transformations.rotation_matrix(np.pi, [0, 1, 0]))
        mesh.metadata.update({"title": name + " — illustrative AI concept", "description": LIMITATION,
                              "generator": "TripoSR", "units": "arbitrary"})
        filenames = []
        def matte_material(tree):
            tree["materials"] = [{
                "name": "Ivory clay — matte",
                "pbrMetallicRoughness": {
                    "baseColorFactor": [1.0, 1.0, 1.0, 1.0],
                    "metallicFactor": 0.0, "roughnessFactor": 0.9,
                },
                "doubleSided": False,
            }]
            for mesh_entry in tree.get("meshes", []):
                for primitive in mesh_entry["primitives"]:
                    primitive["material"] = 0

        for suffix in ["glb", "obj", "stl"]:
            artifact = output / f"{name}.{suffix}"
            if suffix == "glb":
                artifact.write_bytes(trimesh.exchange.gltf.export_glb(
                    trimesh.Scene(mesh), include_normals=True, tree_postprocessor=matte_material,
                ))
            else:
                mesh.export(artifact)
            filenames.append({"path": str(artifact.relative_to(ROOT)), "bytes": artifact.stat().st_size,
                              "sha256": sha256(artifact)})
        loaded = trimesh.load(output / f"{name}.glb", force="mesh", process=False)
        if len(loaded.faces) != len(mesh.faces) or not np.isfinite(loaded.vertices).all():
            raise RuntimeError("GLB round-trip validation failed.")
        item = {
            "name": name, "label": "Prenatal illustration" if name == "prenatal" else "Imagined age one",
            "input": str(path.relative_to(ROOT)), "input_sha256": sha256(path),
            "inference_seconds": round(inference_seconds, 2), "extraction_seconds": round(extraction_seconds, 2),
            "vertices": len(mesh.vertices), "faces": len(mesh.faces), "raw_faces": raw_faces,
            "numerical_seam_vertices_welded": welded_vertices,
            "degenerate_faces_removed": degenerate_faces_removed,
            "tiny_fragment_faces_removed": faces_before_fragment_removal - len(mesh.faces),
            "bounds": mesh.bounds.tolist(), "watertight": bool(mesh.is_watertight),
            "winding_consistent": bool(mesh.is_winding_consistent), "finite_vertices": True,
            "positive_volume": bool(mesh.volume > 0), "units": "arbitrary; not millimeters",
            "printing": "STL is a geometry interchange export, not a print-ready or dimensioned object. "
                        "Self-intersections, minimum thickness, physical scale and slicer behavior are not validated.",
            "glb_roundtrip_passed": True, "files": filenames,
        }
        report["models"].append(item)
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, indent=2) + "\n")
        note(f"{name}: saved {len(mesh.vertices):,} vertices / {len(mesh.faces):,} faces; watertight={mesh.is_watertight}")
        del scene_codes
        if device == "mps":
            torch.mps.empty_cache()

    shutil.copyfile(WORK / "repo/LICENSE", output / "TRIPOSR-LICENSE.txt")
    (output / "README.txt").write_text(
        "ILLUSTRATIVE AI KEEPSAKE MODELS\n\n" + LIMITATION + "\n\n"
        "prenatal.glb / age-one.glb: colored, Y-up meshes for interactive viewing.\n"
        "OBJ exports include vertex colors; software support for those colors varies.\n"
        "STL exports contain geometry only. They are NOT print-ready or dimensioned.\n"
        "Watertightness does not validate self-intersections, minimum thickness,\n"
        "physical scale, fabrication safety, or slicer behavior.\n\n"
        "Generated locally using the official MIT-licensed TripoSR model:\n"
        "https://github.com/VAST-AI-Research/TripoSR\n"
        "The source inputs are AI-generated clay illustrations, not scan volumes.\n"
        "The age-one model is an independent imagined child, not the same child's\n"
        "predicted appearance. See ../pipeline-report.json for provenance and QA,\n"
        "and ../../scripts/generate_meshes.py for the reproducible workflow.\n"
    )
    note(f"Complete. Report: {args.report}")


if __name__ == "__main__":
    main()
