import express from "express";
import cors from "cors";
import multer from "multer";
import mongoose from 'mongoose';
import { v2 as cloudinary } from 'cloudinary';
import { CloudinaryStorage } from 'multer-storage-cloudinary';
import 'dotenv/config';

// Helper function to safely destroy Cloudinary resource
const safeCloudinaryDestroy = async (publicId, resourceType = 'image') => {
  if (publicId) {
    try {
      await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
    } catch (e) {
      console.warn(`Could not destroy Cloudinary asset ${publicId}:`, e);
    }
  }
};

// --- CLOUDINARY CONFIGURATION ---
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// --- MONGODB CONFIGURATION ---
const MONGODB_URI = process.env.MONGODB_URI;
const PORT = process.env.PORT || 5001;

// --- MONGOOSE SCHEMAS ---

// Category schema - supports 3 languages
const categorySchema = new mongoose.Schema({
  name: {
    ka: { type: String, required: true, trim: true },
    en: { type: String, required: true, trim: true },
    ru: { type: String, required: true, trim: true },
  },
  uploadDate: { type: Date, default: Date.now },
}, { timestamps: true });

// Product schema - 1 main image + optional gallery images
const productSchema = new mongoose.Schema({
  name: {
    ka: { type: String, required: true, trim: true },
    en: { type: String, required: true, trim: true },
    ru: { type: String, required: true, trim: true },
  },
  description: {
    ka: { type: String, required: true, trim: true },
    en: { type: String, required: true, trim: true },
    ru: { type: String, required: true, trim: true },
  },
  price: { type: Number, required: true, min: 0 },
  category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', required: false },

  // Main image (used for product card / thumbnail)
  mainImageUrl: { type: String, required: false },
  mainImagePublicId: { type: String, required: false },

  // Gallery images (optional extra photos, up to 10)
  galleryImages: [{
    url: { type: String, required: true },
    publicId: { type: String, required: true },
  }],
  inStock: { type: Boolean, default: true },

  uploadDate: { type: Date, default: Date.now },
}, { timestamps: true });

// Social links schema
const socialLinkSchema = new mongoose.Schema({
  whatsapp: { type: String, trim: true, default: '' },
  facebook: { type: String, trim: true, default: '' },
  uploadDate: { type: Date, default: Date.now },
}, { timestamps: true });

// --- MODELS ---
const Category = mongoose.model('Category', categorySchema);
const Product = mongoose.model('Product', productSchema);
const SocialLink = mongoose.model('SocialLink', socialLinkSchema);

// --- EXPRESS APP SETUP ---
const app = express();

// --- MIDDLEWARE ---
// FIX: Cannot use wildcard origin with credentials: true
// Set your frontend URL in FRONTEND_URL env variable, defaults to localhost:3000
const allowedOrigins = process.env.FRONTEND_URL
  ? process.env.FRONTEND_URL.split(',').map(o => o.trim())
  : ['http://localhost:3000'];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (e.g. mobile apps, curl, Postman)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// --- DATABASE CONNECTION CHECK MIDDLEWARE ---
const checkDbConnection = (req, res, next) => {
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({
      error: "Database unavailable",
      message: "MongoDB connection is not ready. Please try again later."
    });
  }
  next();
};

// --- CLOUDINARY MULTER SETUP FOR IMAGES ---
const imageStorage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'shop-products',
    allowed_formats: ['jpg', 'png', 'jpeg', 'gif', 'webp', 'svg'],
    public_id: (req, file) => {
      const timestamp = Date.now();
      const safeName = file.originalname.replace(/\s+/g, '_').replace(/[^\w.-]/g, '');
      return `${timestamp}-${safeName.split('.')[0]}`;
    },
  }
});

const uploadImage = multer({
  storage: imageStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed!'), false);
    }
  }
});

// Upload handler:
//   field "mainImage" → single main image
//   field "gallery"   → up to 10 gallery images
const uploadProductImages = uploadImage.fields([
  { name: 'mainImage', maxCount: 1 },
  { name: 'gallery', maxCount: 10 },
]);

// --- ROUTES ---

app.get("/", (req, res) => {
  res.json({
    message: "Shop Backend API ✅",
    timestamp: new Date().toISOString(),
    database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected'
  });
});

// ========== CATEGORIES ROUTES ==========

app.post("/categories", checkDbConnection, async (req, res) => {
  console.log('📁 Category create request');
  try {
    const { ka, en, ru } = req.body;
    if (!ka || !en || !ru) {
      return res.status(400).json({ error: "All 3 language names are required (ka, en, ru)" });
    }
    const newCategory = new Category({
      name: { ka: ka.trim(), en: en.trim(), ru: ru.trim() }
    });
    await newCategory.save();
    console.log(`✅ Category created: ${newCategory._id}`);
    res.status(201).json({ message: "Category created successfully!", category: newCategory });
  } catch (error) {
    console.error('❌ Error creating category:', error);
    res.status(500).json({ error: "Failed to create category", details: error.message });
  }
});

app.get("/categories", checkDbConnection, async (req, res) => {
  try {
    const categories = await Category.find().sort({ uploadDate: -1 });
    res.json({ categories });
  } catch (error) {
    console.error('❌ Error fetching categories:', error);
    res.status(500).json({ error: "Failed to fetch categories" });
  }
});

app.get("/categories/:id", checkDbConnection, async (req, res) => {
  try {
    const category = await Category.findById(req.params.id);
    if (!category) return res.status(404).json({ error: "Category not found" });
    res.json({ category });
  } catch (error) {
    console.error('❌ Error fetching category:', error);
    res.status(500).json({ error: "Failed to fetch category" });
  }
});

app.put("/categories/:id", checkDbConnection, async (req, res) => {
  console.log('📁 Category edit request');
  try {
    const { ka, en, ru } = req.body;
    const category = await Category.findById(req.params.id);
    if (!category) return res.status(404).json({ error: "Category not found" });
    if (ka) category.name.ka = ka.trim();
    if (en) category.name.en = en.trim();
    if (ru) category.name.ru = ru.trim();
    await category.save();
    res.json({ message: "Category updated successfully!", category });
  } catch (error) {
    console.error('❌ Error updating category:', error);
    res.status(500).json({ error: "Failed to update category", details: error.message });
  }
});

app.delete("/categories/:id", checkDbConnection, async (req, res) => {
  try {
    const category = await Category.findByIdAndDelete(req.params.id);
    if (!category) return res.status(404).json({ error: "Category not found" });
    res.json({ message: "Category deleted successfully" });
  } catch (error) {
    console.error('❌ Error deleting category:', error);
    res.status(500).json({ error: "Failed to delete category" });
  }
});

// ========== PRODUCTS ROUTES ==========

// POST - Create product
// Form-data fields:
//   mainImage  (file, optional)   → main thumbnail shown on product cards
//   gallery    (files, optional)  → up to 10 extra images shown in product detail
//   name_ka, name_en, name_ru
//   desc_ka, desc_en, desc_ru
//   price
//   category   (ObjectId, optional)
app.post("/products", checkDbConnection, uploadProductImages, async (req, res) => {
  console.log('📦 Product create request');
  try {
    const { name_ka, name_en, name_ru, desc_ka, desc_en, desc_ru, price, category } = req.body;

    if (!name_ka || !name_en || !name_ru) {
      return res.status(400).json({ error: "All 3 language names are required (name_ka, name_en, name_ru)" });
    }
    if (!desc_ka || !desc_en || !desc_ru) {
      return res.status(400).json({ error: "All 3 language descriptions are required (desc_ka, desc_en, desc_ru)" });
    }
    if (price === undefined || price === null || price === '') {
      return res.status(400).json({ error: "Price is required" });
    }

    // Main image
    let mainImageUrl = null;
    let mainImagePublicId = null;
    if (req.files?.mainImage?.[0]) {
      mainImageUrl = req.files.mainImage[0].path;
      mainImagePublicId = req.files.mainImage[0].filename;
    }

    // Gallery images
    const galleryImages = [];
    if (req.files?.gallery?.length) {
      for (const file of req.files.gallery) {
        galleryImages.push({ url: file.path, publicId: file.filename });
      }
    }

    const newProduct = new Product({
      name: { ka: name_ka.trim(), en: name_en.trim(), ru: name_ru.trim() },
      description: { ka: desc_ka.trim(), en: desc_en.trim(), ru: desc_ru.trim() },
      price: parseFloat(price),
      category: category || null,
      inStock: req.body.inStock === 'false' ? false : true, 
      mainImageUrl,
      mainImagePublicId,
      galleryImages,
    });

    await newProduct.save();
    const populated = await newProduct.populate('category');
    console.log(`✅ Product created: ${newProduct._id}`);
    res.status(201).json({ message: "Product created successfully!", product: populated });
  } catch (error) {
    console.error('❌ Error creating product:', error);
    res.status(500).json({ error: "Failed to create product", details: error.message });
  }
});

// GET - All products
// Query params:
//   ?search=text   → searches name & description in all 3 languages
//   ?category=id   → filter by category ID
app.get("/products", checkDbConnection, async (req, res) => {
  try {
    const { search, category } = req.query;
    let query = {};

    if (category) {
      query.category = category;
    }

    if (search && search.trim()) {
      const regex = new RegExp(search.trim(), 'i');
      query.$or = [
        { 'name.ka': regex },
        { 'name.en': regex },
        { 'name.ru': regex },
        { 'description.ka': regex },
        { 'description.en': regex },
        { 'description.ru': regex },
      ];
    }

    const products = await Product.find(query)
      .populate('category')
      .sort({ uploadDate: -1 });

    res.json({ products, total: products.length });
  } catch (error) {
    console.error('❌ Error fetching products:', error);
    res.status(500).json({ error: "Failed to fetch products" });
  }
});

// GET - Single product
app.get("/products/:id", checkDbConnection, async (req, res) => {
  try {
    const product = await Product.findById(req.params.id).populate('category');
    if (!product) return res.status(404).json({ error: "Product not found" });
    res.json({ product });
  } catch (error) {
    console.error('❌ Error fetching product:', error);
    res.status(500).json({ error: "Failed to fetch product" });
  }
});

// PUT - Edit product
// To replace main image:          send new "mainImage" file
// To add gallery images:          send new "gallery" files (appended to existing)
// To remove gallery images:       send removeGalleryIds=["publicId1","publicId2"] (JSON array as string)
app.put("/products/:id", checkDbConnection, uploadProductImages, async (req, res) => {
  console.log('📦 Product edit request');
  try {
    const { name_ka, name_en, name_ru, desc_ka, desc_en, desc_ru, price, category, removeGalleryIds } = req.body;
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ error: "Product not found" });

    if (name_ka) product.name.ka = name_ka.trim();
    if (name_en) product.name.en = name_en.trim();
    if (name_ru) product.name.ru = name_ru.trim();
    if (desc_ka) product.description.ka = desc_ka.trim();
    if (desc_en) product.description.en = desc_en.trim();
    if (desc_ru) product.description.ru = desc_ru.trim();
    if (price !== undefined && price !== '') product.price = parseFloat(price);
    if (category !== undefined) product.category = category || null;
    if (req.body.inStock !== undefined) product.inStock = req.body.inStock === 'false' ? false : true;

    // Replace main image if a new one is uploaded
    if (req.files?.mainImage?.[0]) {
      if (product.mainImagePublicId) await safeCloudinaryDestroy(product.mainImagePublicId);
      product.mainImageUrl = req.files.mainImage[0].path;
      product.mainImagePublicId = req.files.mainImage[0].filename;
    }

    // FIX: Safely parse removeGalleryIds - invalid JSON would previously crash the handler
    if (removeGalleryIds) {
      let idsToRemove = [];
      try {
        idsToRemove = JSON.parse(removeGalleryIds);
        if (!Array.isArray(idsToRemove)) idsToRemove = [];
      } catch {
        return res.status(400).json({ error: "removeGalleryIds must be a valid JSON array" });
      }
      for (const pid of idsToRemove) {
        await safeCloudinaryDestroy(pid);
      }
      product.galleryImages = product.galleryImages.filter(
        img => !idsToRemove.includes(img.publicId)
      );
    }

    // Append new gallery images
    if (req.files?.gallery?.length) {
      for (const file of req.files.gallery) {
        product.galleryImages.push({ url: file.path, publicId: file.filename });
      }
    }

    await product.save();
    const populated = await product.populate('category');
    res.json({ message: "Product updated successfully!", product: populated });
  } catch (error) {
    console.error('❌ Error updating product:', error);
    res.status(500).json({ error: "Failed to update product", details: error.message });
  }
});

// DELETE - Delete product (removes all images from Cloudinary)
app.delete("/products/:id", checkDbConnection, async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ error: "Product not found" });

    if (product.mainImagePublicId) await safeCloudinaryDestroy(product.mainImagePublicId);

    for (const img of product.galleryImages) {
      await safeCloudinaryDestroy(img.publicId);
    }

    await Product.findByIdAndDelete(req.params.id);
    res.json({ message: "Product deleted successfully" });
  } catch (error) {
    console.error('❌ Error deleting product:', error);
    res.status(500).json({ error: "Failed to delete product" });
  }
});

// ========== SOCIAL LINKS ROUTES ==========

app.get("/social", checkDbConnection, async (req, res) => {
  try {
    let social = await SocialLink.findOne();
    if (!social) {
      social = await SocialLink.create({ whatsapp: '', facebook: '' });
    }
    res.json({ social });
  } catch (error) {
    console.error('❌ Error fetching social links:', error);
    res.status(500).json({ error: "Failed to fetch social links" });
  }
});

app.put("/social", checkDbConnection, async (req, res) => {
  console.log('🔗 Social links update request');
  try {
    const { whatsapp, facebook } = req.body;
    let social = await SocialLink.findOne();
    if (!social) social = new SocialLink({});
    if (whatsapp !== undefined) social.whatsapp = whatsapp.trim();
    if (facebook !== undefined) social.facebook = facebook.trim();
    await social.save();
    res.json({ message: "Social links updated successfully!", social });
  } catch (error) {
    console.error('❌ Error updating social links:', error);
    res.status(500).json({ error: "Failed to update social links", details: error.message });
  }
});

// --- Global Error Handling ---
app.use((error, req, res, next) => {
  console.error('💥 Error:', error);
  if (error instanceof multer.MulterError) {
    return res.status(400).json({ error: error.message });
  }
  res.status(500).json({ error: error.message || 'Something went wrong!' });
});

// --- 404 Handler ---
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// --- CONNECT TO MONGODB FIRST, THEN START SERVER ---
console.log('🔄 Connecting to MongoDB...');

mongoose.connect(MONGODB_URI)
  .then(() => {
    console.log('✅ Connected to MongoDB successfully!');
    app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`\n📋 Endpoints:`);
      console.log('  Categories:      POST/GET/GET:id/PUT/DELETE /categories');
      console.log('  Products:        POST/GET/GET:id/PUT/DELETE /products');
      console.log('  Products search: GET /products?search=text&category=id');
      console.log('  Social Links:    GET/PUT /social');
      console.log('\n📸 Product image fields (multipart/form-data):');
      console.log('  mainImage              → 1 main image (shown on cards)');
      console.log('  gallery                → up to 10 extra images (shown in detail view)');
      console.log('  removeGalleryIds       → JSON array of publicIds to delete on PUT');
    });
  })
  .catch(err => {
    console.error('❌ Failed to connect to MongoDB:', err.message);
    process.exit(1);
  });

mongoose.connection.on('disconnected', () => {
  console.log('⚠️  MongoDB disconnected');
});

mongoose.connection.on('reconnected', () => {
  console.log('✅ MongoDB reconnected successfully!');
});

process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down gracefully...');
  try {
    await mongoose.connection.close();
    console.log('✅ MongoDB connection closed');
  } catch (err) {
    console.error('❌ Error closing MongoDB connection:', err);
  }
  process.exit(0);
});