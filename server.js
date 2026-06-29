require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { body, validationResult } = require('express-validator');
const path = require('path');
const cloudinary = require('cloudinary').v2;
const admin = require('firebase-admin');
const { v4: uuidv4 } = require('uuid');

// ==================== INITIALIZATION ====================

// Validate required environment variables
const requiredEnvVars = [
  'JWT_SECRET',
  'CLOUDINARY_CLOUD_NAME',
  'CLOUDINARY_API_KEY',
  'CLOUDINARY_API_SECRET',
  'FIREBASE_CONFIG'
];

const missingEnvVars = requiredEnvVars.filter(varName => !process.env[varName]);
if (missingEnvVars.length > 0) {
  console.error(`❌ Missing required environment variables: ${missingEnvVars.join(', ')}`);
  console.error('Please check your .env file');
  process.exit(1);
}

// Initialize Firebase Admin
let firebaseConfig;
try {
  firebaseConfig = JSON.parse(process.env.FIREBASE_CONFIG);
} catch (error) {
  console.error('❌ Invalid FIREBASE_CONFIG JSON format:', error.message);
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(firebaseConfig)
});

const db = admin.firestore();

// Initialize Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// ==================== EXPRESS APP ====================

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== MIDDLEWARE ====================

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://api.qrserver.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https://res.cloudinary.com", "https://api.qrserver.com"],
      frameSrc: ["'self'", "https://www.google.com", "https://www.youtube.com"],
      connectSrc: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false
}));

// CORS
app.use(cors({
  origin: process.env.NODE_ENV === 'production' 
    ? ['https://baptism-blessing.vercel.app', 'https://your-domain.com']
    : ['http://localhost:3000', 'http://localhost:5500', 'http://127.0.0.1:5500'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Compression
app.use(compression());

// JSON and URL encoded
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Static files
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1y',
  etag: true
}));

// ==================== RATE LIMITING ====================

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/', limiter);

// Stricter rate limit for auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Too many authentication attempts, please try again later.',
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/login', authLimiter);

// ==================== MULTER CONFIGURATION ====================

const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only image files (JPEG, PNG, GIF, WEBP, SVG) are allowed'), false);
    }
  }
});

// ==================== JWT CONFIGURATION ====================

const JWT_SECRET = process.env.JWT_SECRET;

// ==================== DATABASE INITIALIZATION ====================

// Initialize default data if not exists
async function initializeDatabase() {
  try {
    // Check if event settings exist
    const eventDoc = await db.collection('settings').doc('event').get();
    if (!eventDoc.exists) {
      await db.collection('settings').doc('event').set({
        babyName: 'Amelia Grace',
        parentsNames: 'Michael & Sarah',
        church: 'St. Mary & St. Mina Coptic Orthodox Church',
        date: 'June 29, 2026',
        time: '10:00 AM',
        reception: "St. Mark's Fellowship Hall",
        mapLink: 'https://maps.google.com/maps?q=St+Mary+%26+St+Mina+Coptic+Orthodox+Church',
        parentsMessage: '"We give thanks to God for the gift of our precious daughter. Her baptism is a celebration of God\'s love and faithfulness to our family. We are blessed beyond measure."',
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      console.log('✅ Default event data created');
    }

    // Check if default timeline items exist
    const timelineSnapshot = await db.collection('timeline').get();
    if (timelineSnapshot.empty) {
      const defaultTimeline = [
        { title: '10:00 AM - Arrival', description: 'Guests arrival and seating', order: 0 },
        { title: '10:15 AM - Prayer', description: 'Opening prayer and hymns', order: 1 },
        { title: '10:30 AM - Holy Baptism', description: 'Sacrament of Holy Baptism', order: 2 },
        { title: '11:15 AM - Photography', description: 'Family photos and memories', order: 3 },
        { title: '11:45 AM - Reception', description: 'Celebration and fellowship', order: 4 }
      ];

      for (const item of defaultTimeline) {
        await db.collection('timeline').add({
          ...item,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }
      console.log('✅ Default timeline data created');
    }

    console.log('✅ Database initialized successfully');
  } catch (error) {
    console.error('❌ Error initializing database:', error);
  }
}

// ==================== AUTHENTICATION MIDDLEWARE ====================

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ message: 'Access token required' });
  }

  try {
    const user = jwt.verify(token, JWT_SECRET);
    req.user = user;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(403).json({ message: 'Token expired' });
    }
    return res.status(403).json({ message: 'Invalid token' });
  }
};

// ==================== API ROUTES ====================

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// ==================== AUTH ROUTES ====================

// Login
app.post('/api/login', [
  body('username').notEmpty().withMessage('Username is required').trim().escape(),
  body('password').notEmpty().withMessage('Password is required')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ message: errors.array()[0].msg });
  }

  const { username, password, rememberMe } = req.body;

  try {
    // Check if user exists in Firestore
    const userSnapshot = await db.collection('users')
      .where('username', '==', username)
      .limit(1)
      .get();

    let userData = null;
    let userDocId = null;

    if (!userSnapshot.empty) {
      userDocId = userSnapshot.docs[0].id;
      userData = userSnapshot.docs[0].data();
    }

    // If no user found, check hardcoded admin (for backwards compatibility)
    if (!userData) {
      // Hardcoded admin check
      if (username === 'admin' && password === 'admin123') {
        // Create admin user in database
        const hashedPassword = await bcrypt.hash('admin123', 10);
        const newUserRef = await db.collection('users').add({
          username: 'admin',
          password: hashedPassword,
          role: 'admin',
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        const token = jwt.sign(
          { username: 'admin', role: 'admin' },
          JWT_SECRET,
          { expiresIn: rememberMe ? '30d' : '24h' }
        );

        return res.json({ 
          token, 
          message: 'Login successful',
          user: { username: 'admin', role: 'admin' }
        });
      }
      
      return res.status(401).json({ message: 'Invalid username or password' });
    }

    // Verify password
    const isValidPassword = await bcrypt.compare(password, userData.password);
    if (!isValidPassword) {
      return res.status(401).json({ message: 'Invalid username or password' });
    }

    // Generate token
    const token = jwt.sign(
      { username: userData.username, role: userData.role || 'admin' },
      JWT_SECRET,
      { expiresIn: rememberMe ? '30d' : '24h' }
    );

    res.json({ 
      token, 
      message: 'Login successful',
      user: { username: userData.username, role: userData.role || 'admin' }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ message: 'Server error during login' });
  }
});

// Logout
app.post('/api/logout', authenticateToken, (req, res) => {
  res.json({ message: 'Logged out successfully' });
});

// ==================== EVENT ROUTES ====================

// GET event details
app.get('/api/event', async (req, res) => {
  try {
    const doc = await db.collection('settings').doc('event').get();
    if (doc.exists) {
      const data = doc.data();
      // Remove server timestamp from response
      delete data.createdAt;
      delete data.updatedAt;
      res.json(data);
    } else {
      // Return default event data
      res.json({
        babyName: 'Amelia Grace',
        parentsNames: 'Michael & Sarah',
        church: 'St. Mary & St. Mina Coptic Orthodox Church',
        date: 'June 29, 2026',
        time: '10:00 AM',
        reception: "St. Mark's Fellowship Hall",
        mapLink: 'https://maps.google.com/maps?q=St+Mary+%26+St+Mina+Coptic+Orthodox+Church',
        parentsMessage: '"We give thanks to God for the gift of our precious daughter. Her baptism is a celebration of God\'s love and faithfulness to our family. We are blessed beyond measure."'
      });
    }
  } catch (error) {
    console.error('Error fetching event:', error);
    res.status(500).json({ message: 'Error fetching event details' });
  }
});

// PUT update event details
app.put('/api/event', authenticateToken, [
  body('babyName').optional().isString().trim(),
  body('parentsNames').optional().isString().trim(),
  body('church').optional().isString().trim(),
  body('date').optional().isString().trim(),
  body('time').optional().isString().trim(),
  body('reception').optional().isString().trim(),
  body('mapLink').optional().isURL().withMessage('Invalid URL format'),
  body('parentsMessage').optional().isString().trim()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ message: errors.array()[0].msg });
  }

  try {
    const eventData = req.body;
    await db.collection('settings').doc('event').set({
      ...eventData,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    
    res.json({ message: 'Event updated successfully', data: eventData });
  } catch (error) {
    console.error('Error updating event:', error);
    res.status(500).json({ message: 'Error updating event details' });
  }
});

// ==================== GALLERY ROUTES ====================

// GET gallery images
app.get('/api/gallery', async (req, res) => {
  try {
    const snapshot = await db.collection('gallery')
      .orderBy('createdAt', 'desc')
      .get();
    
    const images = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      images.push({ 
        id: doc.id, 
        ...data,
        // Remove server timestamp from response
        createdAt: data.createdAt ? data.createdAt.toDate().toISOString() : null
      });
    });
    res.json(images);
  } catch (error) {
    console.error('Error fetching gallery:', error);
    res.status(500).json({ message: 'Error fetching gallery' });
  }
});

// POST upload image
app.post('/api/gallery', authenticateToken, upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: 'No image file provided' });
  }

  try {
    // Upload to Cloudinary
    const result = await new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          folder: 'baptism-blessing/gallery',
          transformation: [
            { width: 1200, crop: 'limit', quality: 'auto' }
          ],
          public_id: `gallery_${uuidv4()}`
        },
        (error, result) => {
          if (error) reject(error);
          else resolve(result);
        }
      );
      uploadStream.end(req.file.buffer);
    });

    // Save to Firestore
    const imageData = {
      url: result.secure_url,
      publicId: result.public_id,
      title: req.body.title || 'Image',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    const docRef = await db.collection('gallery').add(imageData);
    res.status(201).json({ 
      message: 'Image uploaded successfully',
      id: docRef.id,
      url: result.secure_url,
      publicId: result.public_id,
      title: imageData.title
    });
  } catch (error) {
    console.error('Error uploading image:', error);
    res.status(500).json({ message: 'Error uploading image' });
  }
});

// DELETE gallery image
app.delete('/api/gallery/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;

  try {
    // Get image data to delete from Cloudinary
    const doc = await db.collection('gallery').doc(id).get();
    if (!doc.exists) {
      return res.status(404).json({ message: 'Image not found' });
    }

    const imageData = doc.data();
    
    // Delete from Cloudinary
    if (imageData.publicId) {
      await cloudinary.uploader.destroy(imageData.publicId);
    }

    // Delete from Firestore
    await db.collection('gallery').doc(id).delete();
    res.json({ message: 'Image deleted successfully' });
  } catch (error) {
    console.error('Error deleting image:', error);
    res.status(500).json({ message: 'Error deleting image' });
  }
});

// ==================== VIDEO ROUTES ====================

// GET videos
app.get('/api/videos', async (req, res) => {
  try {
    const snapshot = await db.collection('videos')
      .orderBy('createdAt', 'desc')
      .get();
    
    const videos = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      videos.push({ 
        id: doc.id, 
        ...data,
        createdAt: data.createdAt ? data.createdAt.toDate().toISOString() : null
      });
    });
    res.json(videos);
  } catch (error) {
    console.error('Error fetching videos:', error);
    res.status(500).json({ message: 'Error fetching videos' });
  }
});

// POST add video
app.post('/api/video', authenticateToken, [
  body('url').isURL().withMessage('Valid URL is required'),
  body('title').optional().isString().trim(),
  body('description').optional().isString().trim()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ message: errors.array()[0].msg });
  }

  try {
    const videoData = {
      url: req.body.url,
      title: req.body.title || 'Video',
      description: req.body.description || '',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    const docRef = await db.collection('videos').add(videoData);
    res.status(201).json({ 
      message: 'Video added successfully',
      id: docRef.id,
      ...videoData
    });
  } catch (error) {
    console.error('Error adding video:', error);
    res.status(500).json({ message: 'Error adding video' });
  }
});

// DELETE video
app.delete('/api/video/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;

  try {
    const doc = await db.collection('videos').doc(id).get();
    if (!doc.exists) {
      return res.status(404).json({ message: 'Video not found' });
    }

    await db.collection('videos').doc(id).delete();
    res.json({ message: 'Video deleted successfully' });
  } catch (error) {
    console.error('Error deleting video:', error);
    res.status(500).json({ message: 'Error deleting video' });
  }
});

// ==================== TIMELINE ROUTES ====================

// GET timeline
app.get('/api/timeline', async (req, res) => {
  try {
    const snapshot = await db.collection('timeline')
      .orderBy('order', 'asc')
      .get();
    
    const items = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      items.push({ 
        id: doc.id, 
        ...data,
        createdAt: data.createdAt ? data.createdAt.toDate().toISOString() : null
      });
    });
    res.json(items);
  } catch (error) {
    console.error('Error fetching timeline:', error);
    res.status(500).json({ message: 'Error fetching timeline' });
  }
});

// POST add timeline item
app.post('/api/timeline', authenticateToken, [
  body('title').notEmpty().withMessage('Title is required').trim(),
  body('description').optional().isString().trim()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ message: errors.array()[0].msg });
  }

  try {
    // Get current count for order
    const snapshot = await db.collection('timeline').get();
    const order = snapshot.size;

    const timelineData = {
      title: req.body.title,
      description: req.body.description || '',
      order: order,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    const docRef = await db.collection('timeline').add(timelineData);
    res.status(201).json({ 
      message: 'Timeline item added successfully',
      id: docRef.id,
      ...timelineData
    });
  } catch (error) {
    console.error('Error adding timeline item:', error);
    res.status(500).json({ message: 'Error adding timeline item' });
  }
});

// PUT update timeline item
app.put('/api/timeline/:id', authenticateToken, [
  body('title').optional().isString().trim(),
  body('description').optional().isString().trim(),
  body('order').optional().isInt({ min: 0 })
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ message: errors.array()[0].msg });
  }

  const { id } = req.params;

  try {
    const doc = await db.collection('timeline').doc(id).get();
    if (!doc.exists) {
      return res.status(404).json({ message: 'Timeline item not found' });
    }

    await db.collection('timeline').doc(id).update({
      ...req.body,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    res.json({ message: 'Timeline item updated successfully' });
  } catch (error) {
    console.error('Error updating timeline item:', error);
    res.status(500).json({ message: 'Error updating timeline item' });
  }
});

// DELETE timeline item
app.delete('/api/timeline/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;

  try {
    const doc = await db.collection('timeline').doc(id).get();
    if (!doc.exists) {
      return res.status(404).json({ message: 'Timeline item not found' });
    }

    await db.collection('timeline').doc(id).delete();
    res.json({ message: 'Timeline item deleted successfully' });
  } catch (error) {
    console.error('Error deleting timeline item:', error);
    res.status(500).json({ message: 'Error deleting timeline item' });
  }
});

// ==================== FALLBACK ROUTE ====================

// Serve index.html for all other routes (SPA support)
app.get('*', (req, res) => {
  // Don't serve index.html for API routes
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ message: 'API endpoint not found' });
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ==================== ERROR HANDLING ====================

// 404 handler
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    res.status(404).json({ message: 'API endpoint not found' });
  } else {
    res.status(404).sendFile(path.join(__dirname, 'public', 'index.html'));
  }
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Server Error:', err);
  
  // Multer error handling
  if (err instanceof multer.MulterError) {
    if (err.code === 'FILE_TOO_LARGE') {
      return res.status(413).json({ message: 'File too large. Maximum size is 10MB' });
    }
    return res.status(400).json({ message: err.message });
  }

  // JWT error handling
  if (err.name === 'JsonWebTokenError') {
    return res.status(403).json({ message: 'Invalid token' });
  }

  if (err.name === 'TokenExpiredError') {
    return res.status(403).json({ message: 'Token expired' });
  }

  // Default error
  res.status(500).json({ 
    message: 'Internal server error',
    error: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// ==================== START SERVER ====================

// Initialize database before starting server
initializeDatabase().then(() => {
  app.listen(PORT, () => {
    console.log('=================================');
    console.log('🕊️  Baptism Blessing Server');
    console.log('=================================');
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`📱 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`🔐 JWT: ${JWT_SECRET ? 'Configured ✅' : 'Missing ❌'}`);
    console.log(`☁️  Cloudinary: ${process.env.CLOUDINARY_CLOUD_NAME ? 'Configured ✅' : 'Missing ❌'}`);
    console.log(`🔥 Firebase: ${firebaseConfig.project_id ? 'Configured ✅' : 'Missing ❌'}`);
    console.log('=================================');
    console.log('📋 Default Admin Credentials:');
    console.log('   Username: admin');
    console.log('   Password: admin123');
    console.log('=================================');
    console.log('💡 Change default credentials in production!');
    console.log('=================================');
  });
});

// ==================== EXPORT FOR TESTING ====================

module.exports = app;
