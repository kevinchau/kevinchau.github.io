# Artistic 3D keepsakes: method and limits

These keepsakes are illustrations. They are not a reconstruction of this baby's measured anatomy, a verified likeness, a medical result, or a prediction of appearance at one year.

## Available source material

The original gallery contains redacted JPEG stills and MP4 cine clips. The user confirmed that only those website assets are available for this task. They contain no accessible volumetric dataset, calibrated slice positions, or synchronized probe tracking. Frames from a moving clip cannot simply be stacked as equally spaced depth slices: motion through time is not known spatial geometry.

`media/view-035.jpg`, an anatomy-study side profile, was the sole ultrasound reference supplied to image generation. The earlier-study image `media/view-168.jpg` is provided only as separate viewing context. Different studies were not registered or combined into a volume.

## What was generated

1. The built-in image-generation tool produced a warm ivory clay prenatal-inspired bust, loosely referencing the profile silhouette in view 035. Its face and unseen surfaces are invented. This first step is not an open-source ultrasound reconstruction algorithm.
2. The same tool independently produced an imagined one-year-old clay bust, without an ultrasound reference. It does not perform validated age progression or identity preservation. The sculpture material is an artistic choice; skin, eye, and hair color were not inferred.
3. The open-source TripoSR model is used locally to infer three-dimensional meshes from those generated illustrations. This is single-image object reconstruction of an illustration, not medical reconstruction of a fetus. Input prompts are saved in `output/imagegen/prompts.json`. The reproducible mesh script and machine-readable run report record the actual inference and any platform adaptations.

The generated source portraits are under `output/imagegen/`. The exported meshes are under `output/models/`. Geometry uses arbitrary model coordinates, not millimeters or patient measurements. A rotatable mesh can contain invented, smoothed, or distorted details, especially on the back and sides. Downloadable models are for visual keepsakes and have not been assessed for medical use or physical printing.

The completed prenatal mesh contains 36,041 vertices and 72,078 triangles; the age-one mesh contains 35,700 vertices and 71,396 triangles. Both passed watertightness, consistent winding, finite-coordinate, positive-volume, and GLB reload checks. A tiny numerical seam weld joined near-identical marching-cubes vertices without adding surfaces. Exported GLBs include smooth normals and matte materials. The meshes retain visible low-detail and ripple artifacts from single-image inference; the source artwork is sharper than the actual mesh.

The viewer was checked in Chromium and WebKit at desktop and mobile sizes, including rotation, keyboard focus, zoom, downloads, reduced-motion behavior, and recovery from failed model loads. Front, side, and back views of both meshes were visually inspected. No automatic external requests or uncaught script errors were observed.

## Tools and references

- [TripoSR official source and MIT license](https://github.com/VAST-AI-Research/TripoSR): the open-source image-to-mesh component. Its source and pretrained weights are MIT-licensed according to the project.
- [Three.js](https://github.com/mrdoob/three.js): local browser rendering, MIT-licensed. The viewer vendors its modules and license and makes no automatic requests to external sites.
- [SlicerHeart ultrasound import documentation](https://github.com/SlicerHeart/SlicerHeart/blob/master/Docs/ImageImportExport.md): explains supported volume formats and the distinction between ultrasound screenshots/videos and true 3D data, which may live in vendor-private fields.
- [SlicerIGT reconstruction tutorials](https://www.slicerigt.org/wp/user-tutorial/): tracked reconstruction depends on image-to-position geometry.
- [RapidVol paper](https://arxiv.org/html/2404.10766v1): fetal-brain research using known or estimated slice poses; it does not establish face reconstruction from these untracked exported cines.

## For a future anatomical reconstruction

Ask the clinic for an original acquired 3D/4D ultrasound volume of the face, including voxel geometry, rather than screenshots or a rendered cine. A compatible volumetric DICOM or supported uncompressed GE Voluson/Kretz `.vol` / `.v00` export may be usable in 3D Slicer with SlicerHeart. Include the scanner make/model and export format. Availability depends on what was actually acquired and exported.

Even with a true face volume, a one-year appearance would remain an artistic imagining rather than a reliable prediction.

## Privacy and publication

The existing gallery assets were already publicly hosted and redacted. Only its redacted profile image was supplied to the built-in image-generation tool. TripoSR inference runs locally. The companion viewer loads scripts, models, and images from the same server, with no analytics or remote model service. At the user's request, the companion is hosted separately on [their personal GitHub Pages site](https://kevinchau.github.io/ultrasound-keepsakes/). The original gallery remains unchanged.
