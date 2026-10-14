// The Flux alias Job is the only owner of model routing aliases.
// Keep upstream provider/bootstrap operations unchanged across code revisions.
if (process.argv[2] === 'alias') {
  console.log('omniroute-config: startup alias skipped (owned by Flux)');
} else {
  await import('./manage.mjs');
}
