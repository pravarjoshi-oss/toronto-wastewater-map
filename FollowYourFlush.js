/* ============================================
   JAVASCRIPT FILE FOR FOLLOW YOUR FLUSH WEB APP

   AUTHOR: Pravar Joshi
   DATE: Nov 19, 2025
  
   ============================================ */

/* ============================================
   GLOBAL VARIABLES - Distance tracking
   ============================================ */
   window.__rawWalkingCoords = null;      // Unsmoothed walking route coordinates
   window.__totalFlushDistanceKm = null;  // Combined walking + outfall distance
   
   /* ============================================
      CONFIGURATION - Map & camera settings
      ============================================ */
   
   // Pravar's Mapbox Access Token (this will be removed when posting on blog)
   mapboxgl.accessToken =
     "pk.eyJ1IjoicHJhdmFyMTIiLCJhIjoiY205NW04ZmpqMDJkNDJqb2d1bXl0MzQyMyJ9.8x6vv9N-pW5Cp9rI05B9tw";
   
   // Initial camera position to make sure Toronto extent is covered
   const START_CAMERA = {
     center: [-79.3832, 43.6532],
     zoom: 11.2,
     pitch: 60,
     bearing: -12
   };
   
   // Camera settings
   let CAMERA_ALTITUDE = 300;
   let CAMERA_SPEED = 50;
   
   // Animation control flags
   let animationCancel = false;
   let awaitingEnter = false;
   let showingOutfall = false;
   
   // Callback functions
   window.__continueRoute = null;
   window.__outfallCoords = null;
   window.__lastPlantName = null;
   
   // ArcGIS Online Data URLs (this part of the code can be updated to include data layers from other sources)
   const PLANTS_URL =
     "https://services.arcgis.com/a3UyP711tRR4O2v8/arcgis/rest/services/Wastewater_Treatment_Plants/FeatureServer";
   const CATCH_URL =
     "https://services.arcgis.com/a3UyP711tRR4O2v8/arcgis/rest/services/Wastewater_Treatment_Catchment/FeatureServer";
   
   /* ============================================
      API FUNCTIONS
      ============================================ */
   
   /**
    * Get walking route from Mapbox Directions API to simulate sewer network (this part of code can be replaced with any other network)
    * Stores unsmoothed coordinates for accurate distance calculation
    */
   async function getWalkingRoute(start, end) {
     const url =
       `https://api.mapbox.com/directions/v5/mapbox/walking/` +
       `${start[0]},${start[1]};${end[0]},${end[1]}` +
       `?geometries=geojson&overview=full&access_token=${mapboxgl.accessToken}`;
   
     try {
       const res = await fetch(url);
       const json = await res.json();
       if (!json.routes || json.routes.length === 0) return null;
   
       // Store true unsmoothed coords for distance calculation
       window.__rawWalkingCoords = json.routes[0].geometry.coordinates;
       return json.routes[0].geometry.coordinates;
     } catch {
       return null;
     }
   }
   
   /**
    * Reverse geocode coordinates of user's click to address
    */
   async function reverseGeocode(lng, lat) {
     const url =
       `https://api.mapbox.com/geocoding/v5/mapbox.places/` +
       `${lng},${lat}.json?types=address&limit=1&access_token=${mapboxgl.accessToken}`;
   
     try {
       const res = await fetch(url);
       const data = await res.json();
       if (data.features && data.features.length > 0) {
         return data.features[0].place_name;
       }
     } catch (err) {
       console.error("Reverse geocode failed:", err);
     }
     return "Unknown location in Toronto";
   }
   
   /* ============================================
      UTILITY FUNCTIONS
      ============================================ */
   
   /**
    * Smooth line coordinates using moving average
    * @param {Array} coords - Array of [lng, lat] coordinates
    * @param {Number} win - Window size for smoothing
    */
   function smoothLine(coords, win) {
     if (coords.length <= win) return coords;
     const out = [coords[0]];
   
     for (let i = 1; i < coords.length - 1; i++) {
       let sx = 0, sy = 0, n = 0;
       for (let j = Math.max(0,i-win); j <= Math.min(coords.length-1,i+win); j++) {
         sx += coords[j][0]; sy += coords[j][1]; n++;
       }
       out.push([sx/n, sy/n]);
     }
   
     out.push(coords[coords.length - 1]);
     return out;
   }
   
   /**
    * Build outfall line from treatment plant to water body
    * Uses fixed endpoints for each plant
    */
   function buildOutfallLine(plantName, plantCoords) {
   
     const fixedEndpoints = {
       "North Toronto": [-79.354502, 43.698287],
       "Humber": [-79.471552, 43.628355],
       "Ashbridges Bay": [-79.304403, 43.647421],
       "Highland Creek": [-79.138169, 43.761908]
     };
   
     const endCoord = fixedEndpoints[plantName];
     if (!endCoord) return null;
   
     return {
       type: "Feature",
       geometry: {
         type: "LineString",
         coordinates: [plantCoords, endCoord]
       },
       properties: { plant: plantName }
     };
   }
   
   /**
    * Check if both data sources are loaded
    */
   let loaded = { plants: false, catch: false };
   
   function panelReady() {
     if (loaded.plants && loaded.catch) {
       document.getElementById("panel").innerHTML = `
         <strong>Follow Your Flush!</strong><br/>
         All data used for this web application is from publicly available sources such as
         the City of Toronto's Open Data Portal and Treatment Plant Reports.
       `;
     }
   }
   
   /* ============================================
      ANIMATION FUNCTIONS
      ============================================ */
   
   /**
    * Follow path with free camera animation
    * Animates camera along route coordinates
    */
   function followPathWithFreeCamera(coords) {
     if (!coords || coords.length < 2) return;
   
     const camera = map.getFreeCameraOptions();
     animationCancel = false;
   
     function setCameraAt(i) {
       const here = coords[i];
       const ahead = coords[Math.min(i+6, coords.length-1)];
   
       camera.position = mapboxgl.MercatorCoordinate.fromLngLat(
         { lng: here[0], lat: here[1] },
         CAMERA_ALTITUDE
       );
       camera.lookAtPoint({ lng: ahead[0], lat: ahead[1] });
       map.setFreeCameraOptions(camera);
     }
   
     let i = 0;
   
     function step() {
       // Handle animation skip
       if (animationCancel) {
           map.easeTo({
               center: coords[coords.length - 1],
               zoom: 15,
               pitch: 50,
               bearing: 0,
               duration: 1000
           });
           setTimeout(() => revealTreatmentModal(), 1000);
           return;
       }
   
       setCameraAt(i);
       i++;
   
       if (i < coords.length - 1) {
         setTimeout(step, CAMERA_SPEED);
       } else {
         if (!showingOutfall) {
           // End at plant: show treatment modal
           revealTreatmentModal();
         } else {
           // Outfall animation completed
           showingOutfall = false;
   
           const end = coords[coords.length - 1];
   
           // Move camera to top-down view
           map.easeTo({
               center: end,
               zoom: 16,
               pitch: 0,
               bearing: 0,
               duration: 1500
           });
   
           // Show final outfall modal with distance calculation
           setTimeout(() => {
   
             // Compute unsmoothed walking distance
             let walkKm = 0;
             if (window.__rawWalkingCoords) {
               walkKm = turf.length(
                   turf.lineString(window.__rawWalkingCoords),
                   { units: "kilometers" }
               );
             }
   
             // Compute outfall pipe distance
             let outfallKm = 0;
             if (window.__outfallCoords) {
               outfallKm = turf.length(
                   turf.lineString(window.__outfallCoords),
                   { units: "kilometers" }
               );
             }
   
             // Calculate total distance
             window.__totalFlushDistanceKm = walkKm + outfallKm;
             const rounded = window.__totalFlushDistanceKm.toFixed(2);
   
             // Update modal content
             document.getElementById("final-distance-text").innerHTML = `
               Your flush's journey ends either directly in Lake Ontario or will eventually flow there.
               <br><br>
   
               The estimated distance your wastewater traveled was <strong>${walkKm.toFixed(2)} km</strong> to reach the treatment plant,
               followed by an additional <strong>${outfallKm.toFixed(2)} km</strong>
               through the outfall pipe into the receiving water body.
               <br><br>
   
               <span style="font-size: 12.5px; opacity: 0.85;">
                 <strong>Note:</strong> Outfall pipe lengths vary by treatment plant.
                 Toronto is currently extending the Ashbridges Bay outfall to 3.5 km to improve near-shore water quality.
                 (<a href="https://www.toronto.ca/services-payments/water-environment/managing-rain-melted-snow/what-the-city-is-doing-stormwater-management-projects/lower-don-river-taylor-massey-creek-and-inner-harbour-program/projects-of-the-lower-don-river-taylor-massey-creek-and-inner-harbour-program/"
                      target="_blank" style="color:#1b72ff;">
                   Learn more
                 </a>)
               </span>`;
   
             // Display modal
             document.getElementById("final-outfall-modal").style.display = "flex";
   
           }, 1600);
         }
       }
     }
   
     // Initial camera ease
     map.easeTo({
       center: coords[0], zoom: 14, pitch: 65, bearing: 0, duration: 900
     });
   
     setTimeout(step, 950);
   }
   
   /**
    * Display treatment modal
    */
   function revealTreatmentModal() {
     const modal = document.getElementById("treatment-modal");
     modal.style.display = "flex";
   }
   
   /* ============================================
      EVENT HANDLERS
      ============================================ */
   
   /**
    * Keyboard event handler
    * Space: Skip animation or close modals
    * Enter: Continue from click info modal or close intro
    */
   document.addEventListener("keydown", (e) => {
     // Close intro modal on Enter
     const introModal = document.getElementById("intro-modal");
     if (introModal && introModal.style.display === "flex" && e.key === "Enter") {
         const box = document.getElementById("intro-box");
         box.style.animation = "introFadeOut 0.35s ease-out forwards";
         setTimeout(() => {
             introModal.style.display = "none";
             clickTooltip.style.opacity = "1";
         }, 300);
         return;
     }
     
     if (e.code === "Space") {
       // Close final outfall modal
       const finalOutfallModal = document.getElementById("final-outfall-modal");
       if (finalOutfallModal && finalOutfallModal.style.display === "flex" && e.code === "Space") {
         finalOutfallModal.style.display = "none";
         return;
       }
       
       const modal = document.getElementById("treatment-modal");
   
       // Close treatment modal and show outfall animation
       if (modal.style.display === "flex") {
         modal.style.display = "none";
         animationCancel = false;
   
         // Build outfall lines
         const plantSrc = map.getSource("plants");
         if (plantSrc && plantSrc._data) {
           const outfallFeatures = [];
   
           plantSrc._data.features.forEach(f => {
             const name = f.properties.Plant_Name;
             if ([
               "Humber",
               "Ashbridges Bay",
               "Highland Creek",
               "North Toronto"
             ].includes(name)) {
               const line = buildOutfallLine(name, f.geometry.coordinates);
               if (line) {
                 outfallFeatures.push(line);
                 if (name === window.__lastPlantName) {
                   window.__outfallCoords = line.geometry.coordinates;
                 }
               }
             }
           });
   
           const outfallSource = map.getSource("outfalls");
           if (outfallSource) {
             outfallSource.setData({
               type: "FeatureCollection",
               features: outfallFeatures
             });
           }
         }
   
         // Animate outfall path
         if (window.__outfallCoords && window.__outfallCoords.length > 1) {
           showingOutfall = true;
           setTimeout(() => followPathWithFreeCamera(window.__outfallCoords), 600);
         }
   
         return;
       }
   
       // Skip animation
       animationCancel = true;
   
     } else if (awaitingEnter && e.key === "Enter") {
       awaitingEnter = false;
       document.getElementById("click-info-modal").style.display = "none";
       if (typeof window.__continueRoute === "function") {
         window.__continueRoute();
         window.__continueRoute = null;
       }
     }
   });
   
   /**
    * Camera height slider handler
    */
   document.getElementById("height-slider").oninput = function() {
     CAMERA_ALTITUDE = Number(this.value);
     document.getElementById("height-value").textContent = CAMERA_ALTITUDE + " m";
   };
   
   /**
    * Camera speed slider handler
    */
   document.getElementById("speed-slider").oninput = function() {
     CAMERA_SPEED = Number(this.value);
     document.getElementById("speed-value").textContent = CAMERA_SPEED + " ms";
   };
   
   /**
    * Tooltip follows cursor
    */
   const clickTooltip = document.getElementById("click-tooltip");
   
   document.addEventListener("mousemove", (e) => {
     if (clickTooltip.style.opacity === "1") {
       clickTooltip.style.left = (e.clientX + 12) + "px";
       clickTooltip.style.top = (e.clientY + 16) + "px";
     }
   });
   
   /* ============================================
      MAP INITIALIZATION
      ============================================ */
   
   const map = new mapboxgl.Map({
     container: "map",
     style: "mapbox://styles/mapbox/streets-v12",
     center: START_CAMERA.center,
     zoom: START_CAMERA.zoom,
     pitch: START_CAMERA.pitch,
     bearing: START_CAMERA.bearing,
     antialias: true
   });
   
   /* ============================================
      MAP LOAD EVENT - Setup layers and data
      ============================================ */
   
   map.on("load", () => {
   
     /* ==========================================
        TERRAIN & SKY LAYERS
        ========================================== */
     map.addSource("dem", {
       type: "raster-dem",
       url: "mapbox://mapbox.mapbox-terrain-dem-v1",
       tileSize: 512,
       maxzoom: 14
     });
     map.setTerrain({ source: "dem", exaggeration: 1.5 });
   
     map.addLayer({
       id: "sky",
       type: "sky",
       paint: { "sky-type": "atmosphere", "sky-atmosphere-sun-intensity": 10 }
     });
   
     /* ==========================================
        TORONTO BOUNDARY LAYER
        ========================================== */
     map.addSource("toronto-boundary", {
       type: "vector",
       url: "mapbox://mapbox.mapbox-streets-v8"
     });
   
     map.addLayer({
       id: "toronto-boundary-line",
       type: "line",
       source: "toronto-boundary",
       "source-layer": "admin",
       filter: [
         "all",
         ["==", ["get", "admin_level"], 8],
         ["==", ["get", "maritime"], 0],
         ["==", ["get", "name_en"], "Toronto"]
       ],
       paint: {
         "line-color": "#000000",
         "line-width": 2.5
       }
     });
   
     /* ==========================================
        ROUTE LINE LAYER - Walking path visualization
        ========================================== */
     map.addSource("route", {
       type: "geojson",
       data: { type: "FeatureCollection", features: [] }
     });
     map.addLayer({
       id: "route-line",
       type: "line",
       source: "route",
       paint: { "line-color": "#1b72ff", "line-width": 4 }
     });
   
     /* ==========================================
        OUTFALL LINES LAYER - Plant to water body
        ========================================== */
     map.addSource("outfalls", {
       type: "geojson",
       data: {
         type: "FeatureCollection",
         features: []
       }
     });
   
     map.addLayer({
       id: "outfalls-line",
       type: "line",
       source: "outfalls",
       paint: {
         "line-color": "#0099ff",
         "line-width": 4,
         "line-dasharray": [1.5, 1.5]
       }
     });
   
     /* ==========================================
        LOAD TREATMENT PLANTS DATA
        ========================================== */
     fetch(`${PLANTS_URL}/0/query?where=1=1&outFields=*&outSR=4326&f=geojson`)
       .then(r => r.json())
       .then(data => {
         map.addSource("plants", { type: "geojson", data });
         
         // Plant marker layer
         map.addLayer({
           id: "plants-layer",
           type: "circle",
           source: "plants",
           paint: {
             "circle-radius": 8,
             "circle-color": "#ff0033",
             "circle-stroke-width": 2,
             "circle-stroke-color": "#fff"
           },
           layout: { visibility: "none" }
         });
   
         // Plant labels layer
         map.addLayer({
           id: "plants-labels",
           type: "symbol",
           source: "plants",
           layout: {
             "text-field": ["concat", ["get", "Plant_Name"], " Treatment Plant"],
             "text-size": 14,
             "text-offset": [0, 1.2],
             "text-anchor": "top",
             "visibility": "none"
           },
           paint: {
             "text-color": "#000000",
             "text-halo-color": "#ffffff",
             "text-halo-width": 1.2
           }
         });
   
         loaded.plants = true;
         panelReady();
       });
   
     /* ==========================================
        LOAD CATCHMENT AREAS DATA
        ========================================== */
     fetch(`${CATCH_URL}/0/query?where=1=1&outFields=*&outSR=4326&f=geojson`)
       .then(r => r.json())
       .then(data => {
         map.addSource("catchments", { type: "geojson", data });
         
         // Catchment fill layer
         map.addLayer({
           id: "catch-fill",
           type: "fill",
           source: "catchments",
           paint: { "fill-color": "#00ff00", "fill-opacity": 0.25 },
           layout: { visibility: "none" }
         });
         
         loaded.catch = true;
         panelReady();
       });
   
     /* ==========================================
        MAP CLICK HANDLER - Main interaction
        ========================================== */
     map.on("click", async (e) => {
       // Hide tooltip after first click
       clickTooltip.style.opacity = "0";
   
       const lngLat = [e.lngLat.lng, e.lngLat.lat];
       const pt = turf.point(lngLat);
   
       const catchSrc = map.getSource("catchments");
       const plantSrc = map.getSource("plants");
   
       // Check if data is loaded
       if (!catchSrc || !catchSrc._data || !plantSrc || !plantSrc._data) {
         alert("Data still loading…");
         return;
       }
   
       // Find which catchment area was clicked
       let plantName = null;
       for (const f of catchSrc._data.features) {
         if (turf.booleanPointInPolygon(pt, f)) {
           plantName = f.properties.Plant;
           break;
         }
       }
   
       // Outside Toronto boundary
       if (!plantName) {
         alert("That's outside of Toronto's boundary!");
         return;
       }
   
       // Find matching treatment plant
       const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
       const target = norm(plantName);
   
       let plantFeature = plantSrc._data.features.find(
         f => norm(f.properties.Plant_Name) === target
       );
   
       // Peel region catchment
       if (!plantFeature) {
         alert("This area is serviced by Peel region's treatment plants!");
         return;
       }
   
       // Store plant name for outfall animation
       window.__lastPlantName = plantFeature.properties.Plant_Name;
   
       // Highlight selected plant
       map.setFilter("plants-layer", [
         "==", ["get", "Plant_Name"], plantFeature.properties.Plant_Name
       ]);
       map.setLayoutProperty("plants-layer","visibility","visible");
   
       map.setFilter("plants-labels", [
         "==", ["get", "Plant_Name"], plantFeature.properties.Plant_Name
       ]);
       map.setLayoutProperty("plants-labels","visibility","visible");
   
       // Show click info modal with address and plant
       const address = await reverseGeocode(lngLat[0], lngLat[1]);
       document.getElementById("clicked-address").innerHTML =
         `<strong>You clicked near:</strong><br>${address}`;
       document.getElementById("clicked-plant").innerHTML =
         `<strong>This area is serviced by:</strong><br>${plantFeature.properties.Plant_Name} Treatment Plant`;
   
       document.getElementById("click-info-modal").style.display = "flex";
       awaitingEnter = true;
   
       /* ==========================================
          ROUTE CONTINUATION - After Enter is pressed
          ========================================== */
       window.__continueRoute = async () => {
         const plantCoords = plantFeature.geometry.coordinates;
   
         // Get walking route from API
         const route = await getWalkingRoute(lngLat, plantCoords);
         if (!route) {
           alert("Could not generate walking route.");
           return;
         }
   
         // Smooth the route for visualization
         const smoothed = smoothLine(route, 2);
   
         // Update route layer
         map.getSource("route").setData({
           type: "FeatureCollection",
           features: [{
             type: "Feature",
             geometry: { type: "LineString", coordinates: smoothed }
           }]
         });
   
         // Fit map to route bounds
         const bounds = new mapboxgl.LngLatBounds();
         smoothed.forEach(c => bounds.extend(c));
         map.fitBounds(bounds, { padding: 60, duration: 1200 });
   
         // Start camera animation
         document.getElementById("skip-popup").style.display = "block";
         setTimeout(() => followPathWithFreeCamera(smoothed), 1300);
       };
     });
   });