import { z } from 'zod';

// Run before dependencies create schemas: even a caught Function probe violates CSP.
z.config({ jitless: true });
