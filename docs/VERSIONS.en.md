# Igis versions

Short English record only. Technical notes stay in `docs/VERSION-SUMMARY.md` and `docs/dev-log/`.

- V0.75-Clean: workspace baseline and local HTTP origin gate.
- V0.81: AI data boundary and execution boundary.
- V0.82: execution context isolation.
- V0.83: CRS and unit framework.
- V0.84: map display and cache.
- V0.85: contract freeze.
- V0.86: contract close-out.
- V0.87: added analysis tools.
- V0.88: external GDAL capability boundary.
- V0.89: CRS compatibility, chat interaction, and more tools.
- V0.89.1: review fixes.
- V0.89.2: reprojection and per-conversation workspace.
- V0.89.3: interpreter, resource tree, and failure fingerprint.
- V0.89.4: preview fields, CRS text, and layer names inside a conversation.
- V0.89.5: planar meter operations and outbound geometry checks.
- V0.89.6: removed unused packages from the startup path.
- V0.89.7: sidebar, wrapping, and new-conversation guidance.
- V0.89.8: undeclared distance, vertices, and conversation layers.
- V0.89f: window address and directory layout.
- V0.91: field calculation, attribute join, raster tools, and interpolation.
- V0.91.1: the desktop window accepts dropped files.
- V0.92: English interface, tool text, and model prompt.
- V0.93.1: more local analysis tools; GDAL bridge text stays UTF-8.
- V0.93.2: optional local weights for kriging and watershed; profile and cut-fill need no weights.
- V0.93.3: local execution only for unambiguous sentences; missing distance is not filled with 200 meters.
- V0.94.1: flat/3D switch in the map column; water-level depth from a DEM; layer order and geology inputs are recorded only; weights install from Settings.
- V0.94.2: rotatable 3D terrain with raster overlays, time playback, exploded view, and geological body; rainfall runoff (ANUGA), rainfall landslide (TRIGRS), and geological modelling (LoopStructural) with several scenarios per DEM; compute engines install from Settings.
- V0.95: frosted warm window; 3D controls live in the resource column; docs match the real tool path; kriging and watershed need installed weights; ArcPy/QGIS fallback, the license-check package, and the fine-tune placeholder are removed.
- V0.95.1: several weight files with one active file; a local training-data index with no coordinates; multi-layer import that reports missing companions per layer and merges complete polygon layers.
- V0.96: coordinates and file paths in model text become short references; watershed no longer stops at one million cells.
- V0.96.1: the model judges the whole request, the listed layer, and the tool before calling; unloaded words are not guessed as layer names; one upload may be up to 1 GB.
- V0.96.2: a cloud send asks in the chat. Send anyway includes coordinates and paths in tool results and keeps them for the next turn. Don't send still sends the sentence, with coordinates and paths reduced to short references. The check uses the same substitution as the send.
- V0.97: each conversation stores its own record, vector layers, uploads, rasters, and 3D scene. Deleting the conversation removes that set. The model reads the dialogue already stored in the conversation.
- V0.97.1: agent rules live in one module, with guidance text and two isolation rules (API keys, and stored files opened by the user). Geometry and paths stay in the conversation and in tool results. The knowledge-base screens are disconnected until that system is redesigned. The synthetic sample library no longer prepares or downloads. Desktop and MCP are wired only in `gis-runtime.ts`.
- V0.97.2: a raster result is a raster id (`ras-` plus 10 hex digits) stored in that conversation. Import accepts GeoTIFF and loads it through map load: the file is kept under the conversation `rasters` directory, and the flat map gains a polygon of its extent.
