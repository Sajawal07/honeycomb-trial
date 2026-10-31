/**
 * ParticleSystem — fixed-size pool (no per-frame allocation).
 * Crumbs have height (z) and cast a shadow; sparks are additive gold glints.
 * Purely visual: uses Math.random and never affects the simulation.
 */
interface Particle {
  active: boolean;
  kind: 0 | 1; // 0 crumb, 1 spark
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  size: number;
  rot: number;
  vr: number;
  life: number;
  maxLife: number;
  shade: number;
}

const CRUMB_COLORS = ['#e2a447', '#c98530', '#a8651e', '#f0c070', '#8a4e16'];

export class ParticleSystem {
  max = 160;
  private pool: Particle[] = [];
  private cursor = 0;

  constructor() {
    for (let i = 0; i < 200; i++) {
      this.pool.push({ active: false, kind: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, size: 1, rot: 0, vr: 0, life: 0, maxLife: 1, shade: 0 });
    }
  }

  private take(): Particle {
    const limit = Math.min(this.max, this.pool.length);
    for (let i = 0; i < limit; i++) {
      const idx = (this.cursor + i) % limit;
      if (!this.pool[idx].active) {
        this.cursor = (idx + 1) % limit;
        return this.pool[idx];
      }
    }
    const p = this.pool[this.cursor % limit];
    this.cursor = (this.cursor + 1) % limit;
    return p;
  }

  clear(): void {
    for (const p of this.pool) p.active = false;
  }

  crumbs(x: number, y: number, count: number, k: number): void {
    for (let i = 0; i < count; i++) {
      const p = this.take();
      const a = Math.random() * Math.PI * 2;
      const sp = (20 + Math.random() * 70) * k;
      p.active = true;
      p.kind = 0;
      p.x = x;
      p.y = y;
      p.z = 2;
      p.vx = Math.cos(a) * sp;
      p.vy = Math.sin(a) * sp * 0.7;
      p.vz = (60 + Math.random() * 120) * k;
      p.size = (0.8 + Math.random() * 2.2) * k;
      p.rot = Math.random() * Math.PI;
      p.vr = (Math.random() - 0.5) * 12;
      p.maxLife = 1.6 + Math.random() * 1.4;
      p.life = p.maxLife;
      p.shade = Math.floor(Math.random() * CRUMB_COLORS.length);
    }
  }

  sparks(x: number, y: number, count: number, k: number): void {
    for (let i = 0; i < count; i++) {
      const p = this.take();
      const a = Math.random() * Math.PI * 2;
      const sp = (30 + Math.random() * 110) * k;
      p.active = true;
      p.kind = 1;
      p.x = x;
      p.y = y;
      p.z = 0;
      p.vx = Math.cos(a) * sp;
      p.vy = Math.sin(a) * sp - 30 * k;
      p.vz = 0;
      p.size = (0.8 + Math.random() * 1.4) * k;
      p.rot = 0;
      p.vr = 0;
      p.maxLife = 0.5 + Math.random() * 0.6;
      p.life = p.maxLife;
      p.shade = 0;
    }
  }

  update(dt: number): void {
    const g = 520;
    for (const p of this.pool) {
      if (!p.active) continue;
      p.life -= dt;
      if (p.life <= 0) {
        p.active = false;
        continue;
      }
      if (p.kind === 0) {
        p.vz -= g * dt;
        p.z += p.vz * dt;
        if (p.z <= 0) {
          p.z = 0;
          if (Math.abs(p.vz) > 30) {
            p.vz = -p.vz * 0.32;
            p.vx *= 0.55;
            p.vy *= 0.55;
            p.vr *= 0.5;
          } else {
            p.vz = 0;
            p.vx *= 0.9;
            p.vy *= 0.9;
            p.vr *= 0.9;
          }
        }
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.rot += p.vr * dt;
      } else {
        p.vx *= 1 - dt * 2.5;
        p.vy = p.vy * (1 - dt * 2.5) + 40 * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
      }
    }
  }

  draw(ctx: CanvasRenderingContext2D): void {
    // Crumb shadows + bodies.
    for (const p of this.pool) {
      if (!p.active || p.kind !== 0) continue;
      const fade = Math.min(1, p.life / 0.4);
      ctx.globalAlpha = fade * 0.35;
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.ellipse(p.x + p.z * 0.25, p.y + p.size * 0.6, p.size * 1.1, p.size * 0.55, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = fade;
      ctx.save();
      ctx.translate(p.x, p.y - p.z);
      ctx.rotate(p.rot);
      ctx.fillStyle = CRUMB_COLORS[p.shade];
      ctx.beginPath();
      ctx.moveTo(-p.size, -p.size * 0.6);
      ctx.lineTo(p.size * 0.8, -p.size);
      ctx.lineTo(p.size, p.size * 0.7);
      ctx.lineTo(-p.size * 0.6, p.size);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = 'rgba(255,235,190,0.45)';
      ctx.fillRect(-p.size * 0.6, -p.size * 0.6, p.size * 0.7, p.size * 0.4);
      ctx.restore();
    }
    // Sparks.
    ctx.globalCompositeOperation = 'lighter';
    for (const p of this.pool) {
      if (!p.active || p.kind !== 1) continue;
      const t = p.life / p.maxLife;
      ctx.globalAlpha = t;
      ctx.strokeStyle = '#ffd98a';
      ctx.lineWidth = p.size;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x - p.vx * 0.03, p.y - p.vy * 0.03);
      ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }
}
