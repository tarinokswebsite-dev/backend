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

// Helper to safely parse order — returns 999 if empty, missing, or NaN
const parseOrder = (value) => {
  if (value === undefined || value === null || value === '') return 999;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? 999 : parsed;
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

const categorySchema = new mongoose.Schema({
  name: {
    ka: { type: String, required: true, trim: true },
    en: { type: String, required: true, trim: true },
    ru: { type: String, required: true, trim: true },
  },
  description: {
    ka: { type: String, trim: true, default: '' },
    en: { type: String, trim: true, default: '' },
    ru: { type: String, trim: true, default: '' },
  },
  imageUrl: { type: String, default: null },
  imagePublicId: { type: String, default: null },
  order: { type: Number, default: 999 },
  uploadDate: { type: Date, default: Date.now },
}, { timestamps: true });

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
  mainImageUrl: { type: String, required: false },
  mainImagePublicId: { type: String, required: false },
  galleryImages: [{
    url: { type: String, required: true },
    publicId: { type: String, required: true },
  }],
  inStock: { type: Boolean, default: true },
  order: { type: Number, default: 999 },
  uploadDate: { type: Date, default: Date.now },
}, { timestamps: true });

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
const allowedOrigins = process.env.FRONTEND_URL
  ? process.env.FRONTEND_URL.split(',').map(o => o.trim())
  : ['http://localhost:3000'];

app.use(cors({
  origin: (origin, callback) => {
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

// --- CLOUDINARY MULTER SETUP ---
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

const categoryImageStorage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'shop-categories',
    allowed_formats: ['jpg', 'png', 'jpeg', 'gif', 'webp', 'svg'],
    public_id: (req, file) => {
      const timestamp = Date.now();
      const safeName = file.originalname.replace(/\s+/g, '_').replace(/[^\w.-]/g, '');
      return `${timestamp}-${safeName.split('.')[0]}`;
    },
  }
});

const fileFilter = (req, file, cb) => {
  if (file.mimetype.startsWith('image/')) {
    cb(null, true);
  } else {
    cb(new Error('Only image files are allowed!'), false);
  }
};

const uploadImage = multer({
  storage: imageStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter,
});

// ✅ Define uploadCategoryImage BEFORE the wrapper
const uploadCategoryImage = multer({
  storage: categoryImageStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter,
}).single('categoryImage');

// ✅ Wrapper catches multer/cloudinary errors and returns a readable response
const uploadCategoryImageMiddleware = (req, res, next) => {
  uploadCategoryImage(req, res, (err) => {
    if (err) {
      console.error('Multer/Cloudinary error (category):', err);
      return res.status(500).json({ error: 'Image upload failed', details: err.message });
    }
    next();
  });
};

const uploadProductImages = uploadImage.fields([
  { name: 'mainImage', maxCount: 1 },
  { name: 'gallery', maxCount: 10 },
]);

// ✅ Wrapper for product images too
const uploadProductImagesMiddleware = (req, res, next) => {
  uploadProductImages(req, res, (err) => {
    if (err) {
      console.error('Multer/Cloudinary error (product):', err);
      return res.status(500).json({ error: 'Image upload failed', details: err.message });
    }
    next();
  });
};

// --- ROUTES ---

app.get("/", (req, res) => {
  res.json({
    message: "Shop Backend API ✅",
    timestamp: new Date().toISOString(),
    database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected'
  });
});

// ========== CATEGORIES ROUTES ==========

app.post("/categories", checkDbConnection, uploadCategoryImageMiddleware, async (req, res) => {
  console.log('📁 Category create request');
  try {
    const { ka, en, ru, desc_ka, desc_en, desc_ru, order } = req.body;

    if (!ka || !en || !ru) {
      if (req.file?.filename) await safeCloudinaryDestroy(req.file.filename);
      return res.status(400).json({ error: "All 3 language names are required (ka, en, ru)" });
    }

    let imageUrl = null;
    let imagePublicId = null;
    if (req.file) {
      imageUrl = req.file.path;
      imagePublicId = req.file.filename;
    }

    const newCategory = new Category({
      name: { ka: ka.trim(), en: en.trim(), ru: ru.trim() },
      description: {
        ka: desc_ka ? desc_ka.trim() : '',
        en: desc_en ? desc_en.trim() : '',
        ru: desc_ru ? desc_ru.trim() : '',
      },
      imageUrl,
      imagePublicId,
      order: parseOrder(order),
    });

    await newCategory.save();
    console.log(`✅ Category created: ${newCategory._id}`);
    res.status(201).json({ message: "Category created successfully!", category: newCategory });
  } catch (error) {
    console.error('❌ Error creating category:', error);
    if (req.file?.filename) await safeCloudinaryDestroy(req.file.filename);
    res.status(500).json({ error: "Failed to create category", details: error.message });
  }
});

app.get("/categories", checkDbConnection, async (req, res) => {
  try {
    const categories = await Category.find().sort({ order: 1, uploadDate: -1 });
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

app.put("/categories/:id", checkDbConnection, uploadCategoryImageMiddleware, async (req, res) => {
  console.log('📁 Category edit request');
  try {
    const { ka, en, ru, desc_ka, desc_en, desc_ru, order, removeImage } = req.body;

    const category = await Category.findById(req.params.id);
    if (!category) {
      if (req.file?.filename) await safeCloudinaryDestroy(req.file.filename);
      return res.status(404).json({ error: "Category not found" });
    }

    if (ka) category.name.ka = ka.trim();
    if (en) category.name.en = en.trim();
    if (ru) category.name.ru = ru.trim();

    if (desc_ka !== undefined) category.description.ka = desc_ka.trim();
    if (desc_en !== undefined) category.description.en = desc_en.trim();
    if (desc_ru !== undefined) category.description.ru = desc_ru.trim();

    if (order !== undefined) category.order = parseOrder(order);

    if (removeImage === 'true' && !req.file) {
      await safeCloudinaryDestroy(category.imagePublicId);
      category.imageUrl = null;
      category.imagePublicId = null;
    }

    if (req.file) {
      await safeCloudinaryDestroy(category.imagePublicId);
      category.imageUrl = req.file.path;
      category.imagePublicId = req.file.filename;
    }

    await category.save();
    res.json({ message: "Category updated successfully!", category });
  } catch (error) {
    console.error('❌ Error updating category:', error);
    if (req.file?.filename) await safeCloudinaryDestroy(req.file.filename);
    res.status(500).json({ error: "Failed to update category", details: error.message });
  }
});

app.delete("/categories/:id", checkDbConnection, async (req, res) => {
  try {
    const category = await Category.findById(req.params.id);
    if (!category) return res.status(404).json({ error: "Category not found" });

    if (category.imagePublicId) await safeCloudinaryDestroy(category.imagePublicId);

    await Category.findByIdAndDelete(req.params.id);
    res.json({ message: "Category deleted successfully" });
  } catch (error) {
    console.error('❌ Error deleting category:', error);
    res.status(500).json({ error: "Failed to delete category" });
  }
});

// ========== PRODUCTS ROUTES ==========

app.post("/products", checkDbConnection, uploadProductImagesMiddleware, async (req, res) => {
  console.log('📦 Product create request');
  try {
    const { name_ka, name_en, name_ru, desc_ka, desc_en, desc_ru, price, category, order } = req.body;

    if (!name_ka || !name_en || !name_ru) {
      return res.status(400).json({ error: "All 3 language names are required (name_ka, name_en, name_ru)" });
    }
    if (!desc_ka || !desc_en || !desc_ru) {
      return res.status(400).json({ error: "All 3 language descriptions are required (desc_ka, desc_en, desc_ru)" });
    }
    if (price === undefined || price === null || price === '') {
      return res.status(400).json({ error: "Price is required" });
    }

    let mainImageUrl = null;
    let mainImagePublicId = null;
    if (req.files?.mainImage?.[0]) {
      mainImageUrl = req.files.mainImage[0].path;
      mainImagePublicId = req.files.mainImage[0].filename;
    }

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
      order: parseOrder(order),
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
      .sort({ order: 1, uploadDate: -1 });

    res.json({ products, total: products.length });
  } catch (error) {
    console.error('❌ Error fetching products:', error);
    res.status(500).json({ error: "Failed to fetch products" });
  }
});

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

app.put("/products/:id", checkDbConnection, uploadProductImagesMiddleware, async (req, res) => {
  console.log('📦 Product edit request');
  try {
    const { name_ka, name_en, name_ru, desc_ka, desc_en, desc_ru, price, category, order, removeGalleryIds } = req.body;
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
    if (order !== undefined) product.order = parseOrder(order);

    if (req.files?.mainImage?.[0]) {
      if (product.mainImagePublicId) await safeCloudinaryDestroy(product.mainImagePublicId);
      product.mainImageUrl = req.files.mainImage[0].path;
      product.mainImagePublicId = req.files.mainImage[0].filename;
    }

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