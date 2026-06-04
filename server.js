import app from './api/index.js';

const port = Number(process.env.PORT || 3001);

app.listen(port, () => {
  console.log(`[campaign-dashboard] API listening on :${port}`);
});
