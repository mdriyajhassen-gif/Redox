require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path'); 
const { MongoClient } = require('mongodb');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const PORT = process.env.PORT || 3000;

const upload = multer({ storage: multer.memoryStorage() });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
let mongoClient;
let mongoDB;

async function connectMongoDB() {
  const uri = process.env.MONGODB_URI;

  if (!uri) {
    console.warn('MONGODB_URI is not configured yet.');
    return;
  }

  try {
    mongoClient = new MongoClient(uri);
    await mongoClient.connect();

    mongoDB = mongoClient.db();

    await mongoDB.command({ ping: 1 });

    console.log('MongoDB connected successfully!');
  } catch (err) {
    console.error('MongoDB connection failed:', err.message);

    if (mongoClient) {
      await mongoClient.close().catch(() => {});
      mongoClient = undefined;
      mongoDB = undefined;
    }
  }
}

app.get('/live-price', async (req, res) => {
  try {
    const symbol = req.query.symbol || 'EUR/USD';
    const url = `https://api.twelvedata.com/price?symbol=${encodeURIComponent(symbol)}&apikey=${process.env.TWELVE_DATA_KEY}`;
    const response = await fetch(url);
    const data = await response.json();
    if (data.price) {
      res.json({ symbol, price: data.price });
    } else {
      res.json({ error: data.message || 'No price available' });
    }
  } catch (err) {
    res.json({ error: err.message });
  }
});

// Explicitly serve all static files
app.get('/manifest.json', (req, res) => {
  res.sendFile(path.join(__dirname, 'manifest.json'));
});

app.get('/icon.svg', (req, res) => {
  res.sendFile(path.join(__dirname, 'icon.svg'));
});

app.get('/service-worker.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.sendFile(path.join(__dirname, 'service-worker.js'));
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.post('/analyze', upload.fields([{ name: 'chart', maxCount: 1 }, { name: 'chart2', maxCount: 1 }]), async (req, res) => {
  try {
    const chart1 = req.files && req.files.chart ? req.files.chart[0] : null;
    const chart2 = req.files && req.files.chart2 ? req.files.chart2[0] : null;

    if (!chart1) {
      return res.status(400).json({ error: 'No image received.' });
    }

    const strategy = req.body.strategy || 'Swing';
    const timeframe = req.body.timeframe || '5m';

    const model = genAI.getGenerativeModel({
      model: 'gemini-3.5-flash-lite',
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: {
            direction: { type: 'STRING', enum: ['UP', 'DOWN', 'NEUTRAL'] },
            confidence: { type: 'NUMBER' },
            patterns_seen: { type: 'ARRAY', items: { type: 'STRING' } },
            current_price: { type: 'NUMBER' },
            support: { type: 'STRING' },
            resistance: { type: 'STRING' },             
            support_distance_pct: { type: 'NUMBER' },
            resistance_distance_pct: { type: 'NUMBER' },
            reason: { type: 'STRING' }
          },
          required: ['direction', 'confidence', 'patterns_seen', 'current_price', 'support', 'resistance', 'support_distance_pct', 'resistance_distance_pct', 'reason']
        }
      }
    });

    const prompt = `You are a professional trading chart analyst.
Analyze the attached chart screenshot.
Trading strategy: ${strategy}
Timeframe: ${timeframe}

Step 1: Describe what you actually see in the chart — trend, recent candlestick patterns (e.g. hammer, engulfing, doji), and where price is relative to support/resistance.
Step 2: Based on that, decide the direction of the NEXT candle.

Rules:
- direction must be UP, DOWN, or NEUTRAL.
- Use NEUTRAL if the chart is unclear, choppy, or you are not confident.
- confidence is a number from 0 to 100.
- patterns_seen is a list of patterns you actually identified (empty array if none).
- current_price is the closing price of the most recent (last) candle visible in the chart. Use a number.
- support is the nearest visible support price (or "N/A" if not visible).
- resistance is the nearest visible resistance price (or "N/A" if not visible).
- support_distance_pct is the percentage distance from current_price to the support level. Use a positive number. If support is N/A, use 0.
- resistance_distance_pct is the percentage distance from current_price to the resistance level. Use a positive number. If resistance is N/A, use 0.
- reason is one short sentence.`;

    const imagePart1 = {
      inlineData: {
        data: chart1.buffer.toString('base64'),
        mimeType: chart1.mimetype,
      },
    };

    let contents;
    if (chart2) {
      const imagePart2 = {
        inlineData: {
          data: chart2.buffer.toString('base64'),
          mimeType: chart2.mimetype,
        },
      };
      contents = [
        prompt + '\n\nIMPORTANT: Two images are attached. Image 1 is the LARGER timeframe (bigger picture trend). Image 2 is the SMALLER timeframe (entry timing). If the larger-timeframe trend and the smaller-timeframe signal conflict, return direction NEUTRAL.',
        imagePart1,
        imagePart2
      ];
    } else {
      contents = [prompt, imagePart1];
    }

    const result = await model.generateContent(contents);
    const text = result.response.text();

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      return res.status(500).json({ error: 'AI returned invalid JSON: ' + text });
    }

    res.json({ analysis: parsed });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error: ' + err.message });
  }
});

async function startServer() {
  await connectMongoDB();

  app.listen(PORT, () => {
    console.log(`Redox running: http://localhost:${PORT}`);
  });
}

startServer();
