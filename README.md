# Gravity Simulator

A 2D gravity simulator with vector field visualization built with p5.js and TypeScript.

## Features

- **Interactive particle placement**: Click and drag to add objects with custom velocity
- **Particle management**: 
  - Live list of all particles with mass display
  - Individual delete buttons for each particle
  - Clear all button for complete reset
- **Real-time gravity simulation**: N-body gravitational interactions
- **Camera controls**: Full zoom and pan capabilities
  - **Mouse wheel zoom**: Zoom in/out centered on cursor position (10% - 500%)
  - **Pan view**: Middle-click drag or Ctrl+Click drag to move around
  - **Reset camera**: Instantly return to default view
  - Smooth, intuitive navigation for exploring large simulations
- **Adaptive density vector field**: Revolutionary visualization system
  - **Grid Mode Options**:
    - **Adaptive (default)**: Denser near objects, sparser far away - best for detailed force visualization
    - **Uniform**: Regular grid across entire visible area - best for seeing overall field structure
  - **Adaptive mode features**:
    - **4 density zones**: Very close (30% spacing), close (50%), medium (80%), far (120%)
    - Sample points cluster around particles for maximum detail
  - **Uniform mode features**:
    - Evenly spaced grid across entire screen
    - Shows force field everywhere, even in empty space
    - Better for understanding field topology
  - **Color-coded by strength**: Red (strong) → Yellow → Green → Cyan → Blue (weak)
  - **Adjustable range**: Control how far vectors extend from objects (100-800px)
  - Logarithmic scaling for visibility across all force ranges
- **Particle vector visualization**: Each particle displays two vectors
  - **Orange arrow**: Net gravitational force (direction particle is being pulled)
  - **Cyan arrow**: Velocity vector (direction and speed of movement)
- **Particle trails**: Visual history of particle movement
- **Adjustable mass**: Change the mass of particles before adding them (10-200)
- **Visual customization**: Real-time adjustment of object and arrow sizes
- **Pause/Resume**: Control the simulation
- **Responsive**: Automatically adjusts to window size

## Project Structure

```
gravity-simulator/
├── src/
│   ├── main.ts           # Entry point and p5.js sketch
│   ├── Vector2D.ts       # 2D vector math operations
│   ├── Particle.ts       # Particle class with physics
│   ├── VectorField.ts    # Vector field calculation and storage
│   ├── PhysicsEngine.ts  # Main physics engine
│   └── Renderer.ts       # Visualization and rendering
├── index.html            # HTML entry point with UI
├── package.json          # Dependencies and scripts
├── tsconfig.json         # TypeScript configuration
└── vite.config.ts        # Vite bundler configuration
```

## Setup and Installation

### Prerequisites
- Node.js (v16 or higher)
- npm or yarn

### Installation

1. Install dependencies:
```bash
npm install
```

2. Start the development server:
```bash
npm run dev
```

3. Open your browser to `http://localhost:3000`

### Build for Production

```bash
npm run build
```

The built files will be in the `dist/` directory.

## How to Use

1. **Add particles**: Click and drag on the canvas. The direction and length of your drag determines the initial velocity.
2. **Delete particles**: Use the ✕ button next to each particle in the list (bottom-left panel), or use "Clear All" to remove everything.
2. **Adjust mass**: Use the slider in the control panel to change the mass of new particles (10-200).
3. **Adjust vector range**: Use the "Vector Range" slider to control how far the field extends from objects (100-800px).
   - Lower values: Only show strong nearby forces (cleaner, faster)
   - Higher values: Show forces further out (more comprehensive view)
4. **Camera Controls**:
   - **Zoom**: Scroll mouse wheel to zoom in/out (centered on mouse position)
   - **Pan**: Middle-click and drag OR Ctrl+Click and drag to pan the view
   - **Reset Camera**: Click the "Reset Camera" button to return to default view
   - Current zoom level is displayed in the controls panel
5. **Render Settings**:
   - **Object Size** (0.3x - 3.0x): Scale the visual size of particles without affecting physics
   - **Arrow Size** (0.3x - 3.0x): Scale all arrows (field vectors and particle vectors) for better visibility
6. **Grid Mode**: Choose between vector field generation modes
   - **Adaptive**: Denser near objects, sparser far away (best for detail)
   - **Uniform**: Regular grid across screen (best for field structure)
7. **Toggle vector field**: Check/uncheck "Show Vector Field" to show/hide gravitational force arrows across space.
8. **Toggle particle vectors**: Check/uncheck "Show Particle Vectors" to show/hide force and velocity arrows on each particle.
9. **Toggle trails**: Check/uncheck "Show Trails" to show/hide particle paths.
10. **Pause/Resume**: Click the pause button to freeze/unfreeze the simulation.
11. **Clear all**: Remove all particles and start fresh.

## Physics Details

### Gravitational Force
The simulation uses Newton's law of universal gravitation:

```
F = G × m₁ × m₂ / r²
```

Where:
- `G` is the gravitational constant (default: 0.5)
- `m₁` and `m₂` are the masses of the two particles
- `r` is the distance between them

### Integration
The simulation uses Euler integration to update particle positions:

```
velocity = velocity + acceleration × dt
position = position + velocity × dt
```

### Vector Field
The vector field is calculated on a grid, showing the gravitational force at each point in space from all particles. 

**Performance Optimization:** The field uses spatial culling - vectors are only calculated within the "influence radius" of each particle (where the force is significant). This means:
- Near particles: dense, colorful vector fields showing strong forces
- Far from particles: no vectors drawn (negligible forces)
- Performance scales with number and mass of particles, not screen size

## Customization

### Adjust Gravitational Constant
In `PhysicsEngine.ts`, change the `G` value:
```typescript
G: number = 0.5; // Increase for stronger gravity
```

### Adjust Vector Field Resolution
In `PhysicsEngine.ts` constructor, change the grid size:
```typescript
this.vectorField = new VectorField(width, height, 30); // Change 30 to adjust density
// Lower values = more arrows (denser), but slower performance
// Higher values = fewer arrows (sparser), but better performance
```

### Adjust Trail Length
In `Particle.ts`, change `maxTrailLength`:
```typescript
maxTrailLength: number = 50; // Number of trail points
```

### Visual Customization
Use the in-app sliders for real-time adjustments:
- **Object Size (0.3x - 3.0x)**: Makes particles appear larger or smaller without changing physics
  - Useful for presentations or when particles are hard to see
  - Does not affect gravitational calculations
- **Arrow Size (0.3x - 3.0x)**: Scales all arrows uniformly
  - Includes vector field arrows, force vectors, and velocity vectors
  - Great for high-res displays or projectors

## Future Enhancements

Ideas for extending the simulator:
- Collision detection and merging
- Adaptive time-stepping (RK4 integration)
- Spatial partitioning (quadtree) for better performance with many particles
- Save/load simulation states
- Different force laws (inverse cube, etc.)
- 3D visualization
- Orbital mechanics tools (aphelion, perihelion markers)

## Performance Notes

The vector field visualization uses **adaptive density** with spatial culling:
- **4 concentric zones** around each particle with different arrow densities:
  - Very close (0-20% of range): 30% grid spacing (densest)
  - Close (20-40%): 50% spacing
  - Medium (40-70%): 80% spacing  
  - Far (70-100%): 120% spacing (sparsest)
- Sample points avoid duplicates when particle influence zones overlap
- Only generates vectors within the adjustable max range
- Performance scales with: number of particles × range² × base density

**Performance tips:**
- Reduce "Vector Range" slider for faster rendering (fewer samples)
- Increase base grid size in `VectorField.ts` constructor (line 16) for sparser fields
- Toggle off vector field temporarily when adding many particles
- With default settings: smooth 60 FPS with 5-10 particles

## License

MIT
