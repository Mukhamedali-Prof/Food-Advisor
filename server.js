const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = path.join(__dirname, 'public', 'uploads');
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'restaurant-' + uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (!file.mimetype || !file.mimetype.startsWith('image/')) {
            return cb(new Error('Only image files are allowed.'));
        }
        cb(null, true);
    }
});

const express = require('express');
const cookieParser = require('cookie-parser');
const db = require('./config/db');

const app = express();
const PORT = 3000;

function validateTextField(value, { label, required = false, min = 0, max = 500 }) {
    if (typeof value !== 'string') {
        return { ok: false, error: `${label} must be a valid string.` };
    }

    const cleaned = value.trim();

    if (required && cleaned.length === 0) {
        return { ok: false, error: `${label} is required.` };
    }

    if (cleaned.length > 0 && cleaned.length < min) {
        return { ok: false, error: `${label} must be at least ${min} characters long.` };
    }

    if (cleaned.length > max) {
        return { ok: false, error: `${label} must be at most ${max} characters long.` };
    }

    if (cleaned.length > 0) {
        if (/^\d/.test(cleaned)) {
            return { ok: false, error: `${label} cannot start with a digit.` };
        }

        if (!/\p{L}/u.test(cleaned)) {
            return { ok: false, error: `${label} cannot contain only digits and symbols.` };
        }
    }

    return { ok: true, value: cleaned };
}

const isAuthenticated = (req, res, next) => {
    if (req.cookies && req.cookies.user_email) {
        return next();
    }
    return res.redirect('/?modal=login&error=' + encodeURIComponent('Please log in first.'));
};

const requireRole = (requiredRole) => {
    return async (req, res, next) => {
        try {
            if (!req.cookies || !req.cookies.user_email) {
                return res.redirect('/?modal=login');
            }

            const [users] = await db.query('SELECT role, is_blocked FROM users WHERE email = ?', [req.cookies.user_email]);

            if (users.length === 0) {
                res.clearCookie('user_email');
                return res.redirect('/?modal=login');
            }

            const user = users[0];

            if (user.is_blocked) {
                res.clearCookie('user_email');
                return res.redirect('/?modal=login&error=' + encodeURIComponent('Your account is blocked.'));
            }

            if (user.role === requiredRole) {
                return next();
            }

            return res.status(403).send('Access denied. Insufficient permissions.');
        } catch (err) {
            console.error('Access control error:', err);
            return res.status(500).send('Server error');
        }
    };
};

app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

app.use(async (req, res, next) => {
    const email = req.cookies && req.cookies.user_email;
    if (!email) return next();
    try {
        const [rows] = await db.query('SELECT is_blocked FROM users WHERE email = ?', [email]);
        if (rows.length === 0 || rows[0].is_blocked) {
            res.clearCookie('user_email');
            delete req.cookies.user_email;
        }
    } catch (err) {
        console.error('Session check failed:', err);
    }
    next();
});

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    })[char]);
}

function sendRestaurantError(res, title, err, status = 500) {
    const detail = escapeHtml(err.sqlMessage || err.message || 'Unknown error');
    return res.status(status).type('html').send(`
        <!doctype html>
        <html lang="en">
        <head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
        <body style="font-family: sans-serif; padding: 32px; background: #fff5f5;">
            <main style="max-width: 680px; margin: 40px auto; padding: 24px; border: 2px solid #e53935; border-radius: 8px; background: white;">
                <h1 style="color: #c62828;">${escapeHtml(title)}</h1>
                <p>${detail}</p>
                <p>Check the server console for the full error details.</p>
                <a href="/owner-dashboard">Return to owner dashboard</a>
            </main>
        </body>
        </html>
    `);
}

app.post('/favorites/toggle/:id', async (req, res) => {
    try {
        const userEmail = req.cookies.user_email;
        if (!userEmail) return res.redirect('/?modal=login');

        const [users] = await db.query('SELECT id, role FROM users WHERE email = ?', [userEmail]);
        if (users.length === 0 || users[0].role !== 'customer') {
            return res.status(403).send('Only customers can manage favorites.');
        }

        const restaurantId = Number(req.params.id);
        const userId = users[0].id;

        const [existing] = await db.query(
            'SELECT * FROM favorites WHERE user_id = ? AND restaurant_id = ?',
            [userId, restaurantId]
        );

        if (existing.length > 0) {
            await db.query('DELETE FROM favorites WHERE user_id = ? AND restaurant_id = ?', [userId, restaurantId]);
        } else {
            await db.query('INSERT INTO favorites (user_id, restaurant_id) VALUES (?, ?)', [userId, restaurantId]);
        }

        if (req.query.redirect === 'profile') {
            const tab = req.query.tab ? `?tab=${req.query.tab}` : '';
            return res.redirect(`/profile${tab}`);
        }

        return res.redirect(`/restaurant/${restaurantId}`);
    } catch (err) {
        console.error('Failed to toggle favorite:', err);
        return res.status(500).send('Server error');
    }
});

function handleRestaurantImageUpload(req, res, next) {
    upload.single('imageFile')(req, res, (err) => {
        if (!err) return next();
        console.error('Restaurant image upload failed:', err);
        return sendRestaurantError(res, 'Restaurant image upload failed', err, 400);
    });
}

async function getOwnerFromRequest(req) {
    const userEmail = req.cookies && req.cookies.user_email;
    if (!userEmail) return null;

    const [users] = await db.query(
        'SELECT id, username, email, role, avatar FROM users WHERE email = ?',
        [userEmail]
    );
    if (users.length === 0 || users[0].role !== 'owner') return null;
    return users[0];
}

function localDateString(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function isValidBookingDate(value) {
    const match = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match || value < localDateString()) return false;

    const [, year, month, day] = match.map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function isValidBookingTime(value) {
    if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return false;
    return true;
}

async function addNotification(userId, type, message) {
    try {
        await db.query('INSERT INTO notifications (user_id, type, message) VALUES (?, ?, ?)', [userId, type, message]);
    } catch (err) {
        console.error('Failed to save notification:', err);
    }
}

async function safeQuery(sql, params) {
    try {
        await db.query(sql, params);
    } catch (err) {
        if (err.code !== 'ER_NO_SUCH_TABLE') throw err;
    }
}

async function recalcRestaurantRating(restaurantId) {
    try {
        const [result] = await db.query(
            'SELECT AVG(rating) as avgRating FROM reviews WHERE restaurant_id = ? AND is_hidden = 0',
            [restaurantId]
        );

        const newRating = result[0].avgRating ? Number(result[0].avgRating).toFixed(1) : 0;

        await db.query(
            'UPDATE restaurants SET rating = ? WHERE id = ?',
            [newRating, restaurantId]
        );
    } catch (err) {
        console.error('Failed to recalculate restaurant rating:', err);
    }
}

async function deleteRestaurantCascade(restaurantId) {
    await safeQuery('DELETE FROM reviews WHERE restaurant_id = ?', [restaurantId]);
    await safeQuery('DELETE FROM favorites WHERE restaurant_id = ?', [restaurantId]);
    await safeQuery('DELETE FROM bookings WHERE restaurant_id = ?', [restaurantId]);
    await safeQuery('DELETE FROM menu_items WHERE restaurant_id = ?', [restaurantId]);
    await db.query('DELETE FROM restaurants WHERE id = ?', [restaurantId]);
}

async function deleteUserCascade(userId) {
    const [owned] = await db.query('SELECT id FROM restaurants WHERE owner_id = ?', [userId]);
    for (const restaurant of owned) {
        await deleteRestaurantCascade(restaurant.id);
    }

    const [rated] = await db.query('SELECT DISTINCT restaurant_id FROM reviews WHERE user_id = ?', [userId]);

    await safeQuery('DELETE FROM reviews WHERE user_id = ?', [userId]);
    await safeQuery('DELETE FROM favorites WHERE user_id = ?', [userId]);
    await safeQuery('DELETE FROM bookings WHERE customer_id = ?', [userId]);
    await safeQuery('DELETE FROM notifications WHERE user_id = ?', [userId]);
    await db.query('DELETE FROM users WHERE id = ?', [userId]);

    for (const row of rated) {
        await recalcRestaurantRating(row.restaurant_id);
    }
}

async function getNotificationsForUser(user) {
    const items = [];

    try {
        const [hiddenRestaurants] = await db.query(
            'SELECT name FROM restaurants WHERE owner_id = ? AND is_hidden = 1',
            [user.id]
        );
        hiddenRestaurants.forEach((r) => items.push({
            type: 'restaurant_hidden',
            message: `Your restaurant "${r.name}" has been hidden from the service for violating the service rules.`,
            date: null
        }));

        const [hiddenReviews] = await db.query(`
            SELECT restaurants.name AS restaurant_name
            FROM reviews
            JOIN restaurants ON reviews.restaurant_id = restaurants.id
            WHERE reviews.user_id = ? AND reviews.is_hidden = 1
        `, [user.id]);
        hiddenReviews.forEach((r) => items.push({
            type: 'review_hidden',
            message: `Your review of "${r.restaurant_name}" has been hidden for violating the service rules.`,
            date: null
        }));
    } catch (err) {
        console.error('Failed to load hidden-item notifications:', err);
    }

    try {
        const [saved] = await db.query(
            'SELECT type, message, created_at FROM notifications WHERE user_id = ? ORDER BY created_at DESC, id DESC',
            [user.id]
        );
        saved.forEach((n) => items.push({ type: n.type, message: n.message, date: n.created_at }));
    } catch (err) {
        console.error('Failed to load saved notifications:', err);
    }

    return items;
}

app.get('/', async (req, res) => {
    try {
        const userEmail = req.cookies.user_email;
        let currentUser = null;

        if (userEmail) {
            const [users] = await db.query('SELECT * FROM users WHERE email = ?', [userEmail]);
            if (users.length > 0) currentUser = users[0];
        }

        const [stats] = await db.query(`
            SELECT 
                (SELECT COUNT(*) FROM restaurants) as restaurantsCount,
                (SELECT COUNT(*) FROM users) as usersCount,
                (SELECT COUNT(*) FROM reviews) as reviewsCount
        `);
        const [topRestaurants] = await db.query('SELECT * FROM restaurants WHERE (is_hidden = 0 OR is_hidden IS NULL) ORDER BY rating DESC LIMIT 3');
        const [recentReviews] = await db.query(`
            SELECT reviews.*, users.username, restaurants.name as restaurant_name 
            FROM reviews 
            JOIN users ON reviews.user_id = users.id 
            JOIN restaurants ON reviews.restaurant_id = restaurants.id 
            WHERE (reviews.is_hidden = 0 OR reviews.is_hidden IS NULL)
              AND (restaurants.is_hidden = 0 OR restaurants.is_hidden IS NULL)
            ORDER BY reviews.id DESC LIMIT 3
        `);

        res.render('index', { currentUser, stats: stats[0], topRestaurants, recentReviews });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    }
});

app.get('/search', async (req, res) => {
    try {
        const rawQuery = typeof req.query.query === 'string' ? req.query.query.trim() : '';
        const selectedCuisine = typeof req.query.cuisine === 'string' ? req.query.cuisine.trim() : '';
        const selectedLocation = typeof req.query.location === 'string' ? req.query.location.trim() : '';
        const selectedMinRating = typeof req.query.min_rating === 'string' ? req.query.min_rating.trim() : '';
        const selectedMinPrice = typeof req.query.min_price === 'string' ? req.query.min_price.trim() : '';
        const selectedMaxPrice = typeof req.query.max_price === 'string' ? req.query.max_price.trim() : '';

        const conditions = ['(r.is_hidden = 0 OR r.is_hidden IS NULL)'];
        const params = [];

        if (rawQuery) {
            conditions.push('(r.name LIKE ? OR r.cuisine LIKE ? OR r.address LIKE ?)');
            const term = `%${rawQuery}%`;
            params.push(term, term, term);
        }

        if (selectedCuisine) {
            conditions.push('r.cuisine = ?');
            params.push(selectedCuisine);
        }

        if (selectedLocation) {
            conditions.push('r.address LIKE ?');
            params.push(`${selectedLocation},%`);
        }

        if (selectedMinRating) {
            conditions.push('r.rating >= ?');
            params.push(parseFloat(selectedMinRating));
        }

        const havingConditions = [];
        if (selectedMinPrice !== '') {
            havingConditions.push('avg_price >= ?');
            params.push(parseFloat(selectedMinPrice));
        }
        if (selectedMaxPrice !== '') {
            havingConditions.push('avg_price <= ?');
            params.push(parseFloat(selectedMaxPrice));
        }

        let query = `
            SELECT r.*, AVG(m.price) AS avg_price
            FROM restaurants r
            LEFT JOIN menu_items m ON r.id = m.restaurant_id
            WHERE ${conditions.join(' AND ')}
            GROUP BY r.id
        `;

        if (havingConditions.length > 0) {
            query += ` HAVING ${havingConditions.join(' AND ')}`;
        }

        query += ` ORDER BY r.created_at DESC, r.id DESC`;

        const [restaurants] = await db.query(query, params);

        const [cuisines] = await db.query(`
            SELECT DISTINCT cuisine FROM restaurants WHERE is_hidden = 0 OR is_hidden IS NULL ORDER BY cuisine ASC
        `);

        let currentUser = null;
        if (req.cookies.user_email) {
            const [users] = await db.query(
                'SELECT id, username, email, role, avatar FROM users WHERE email = ?',
                [req.cookies.user_email]
            );
            if (users.length > 0) currentUser = users[0];
        }

        return res.render('search-results', {
            restaurants,
            cuisines,
            searchQuery: rawQuery,
            selectedCuisine,
            selectedLocation,
            selectedMinRating,
            selectedMinPrice,
            selectedMaxPrice,
            currentUser
        });
    } catch (err) {
        console.error('Failed to load restaurants:', err);
        return res.status(500).send('Could not load restaurants.');
    }
});

app.post('/restaurant/:id/review', async (req, res) => {
    try {
        const userEmail = req.cookies.user_email;
        if (!userEmail) return res.redirect('/?modal=login');

        const [users] = await db.query('SELECT * FROM users WHERE email = ?', [userEmail]);
        if (users.length === 0) return res.redirect('/');

        const currentUser = users[0];
        const restaurantId = req.params.id;
        const { rating, comment } = req.body;

        const [existingReview] = await db.query(`
            SELECT * FROM reviews WHERE user_id = ? AND restaurant_id = ?
        `, [currentUser.id, restaurantId]);

        if (existingReview.length > 0) {
            return res.status(400).send('You have already left a review for this restaurant. Only one review per restaurant is allowed.');
        }

        const ratingNum = parseInt(rating, 10);
        if (isNaN(ratingNum) || ratingNum < 1 || ratingNum > 5) {
            return res.status(400).send('Invalid rating. Must be between 1 and 5.');
        }

        await db.query(`
            INSERT INTO reviews (user_id, restaurant_id, rating, comment) 
            VALUES (?, ?, ?, ?)
        `, [currentUser.id, restaurantId, ratingNum, comment]);

        await recalcRestaurantRating(restaurantId);

        res.redirect(`/restaurant/${restaurantId}`);
    } catch (err) {
        console.error("Ошибка при создании отзыва:", err);
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(400).send('You have already reviewed this restaurant.');
        }
        res.status(500).send('Server error: ' + err.message);
    }
});

app.get('/restaurant/:id', async (req, res) => {
    try {
        const restaurantId = Number(req.params.id);
        if (!Number.isSafeInteger(restaurantId) || restaurantId <= 0) {
            return res.status(404).send('Restaurant not found.');
        }

        const [restaurants] = await db.query(
            'SELECT * FROM restaurants WHERE id = ? AND (is_hidden = 0 OR is_hidden IS NULL)',
            [restaurantId]
        );
        if (restaurants.length === 0) return res.status(404).send('Restaurant not found.');

        const [reviews] = await db.query(`
            SELECT reviews.*, users.username 
            FROM reviews 
            JOIN users ON reviews.user_id = users.id 
            WHERE reviews.restaurant_id = ? AND (reviews.is_hidden = 0 OR reviews.is_hidden IS NULL) 
            ORDER BY reviews.id DESC
        `, [restaurantId]);

        const [menuItems] = await db.query(
            'SELECT * FROM menu_items WHERE restaurant_id = ? ORDER BY id ASC',
            [restaurantId]
        );

        let currentUser = null;
        let isFavorite = false;

        if (req.cookies.user_email) {
            const [users] = await db.query(
                'SELECT id, username, email, role, avatar FROM users WHERE email = ?',
                [req.cookies.user_email]
            );
            if (users.length > 0) {
                currentUser = users[0];

                if (currentUser.role === 'customer') {
                    const [favCheck] = await db.query(
                        'SELECT * FROM favorites WHERE user_id = ? AND restaurant_id = ?',
                        [currentUser.id, restaurantId]
                    );
                    isFavorite = favCheck.length > 0;
                }
            }
        }

        return res.render('restaurant-detail', {
            restaurant: restaurants[0],
            reviews,
            menuItems,
            currentUser,
            isFavorite,
            minBookingDate: localDateString(),
            bookingMessage: ({
                sent: 'Your booking request was sent. The restaurant owner has been notified.',
                invalid: 'Please enter a valid future date, time range, and guest count.',
                failed: 'The booking could not be saved. Please try again.'
            })[req.query.booking] || null
        });
    } catch (err) {
        console.error('Failed to load restaurant page:', err);
        return res.status(500).send('Could not load this restaurant.');
    }
});

app.post('/restaurant/:id/book', async (req, res) => {
    try {
        const userEmail = req.cookies.user_email;
        if (!userEmail) return res.redirect('/?modal=login');

        const [users] = await db.query('SELECT * FROM users WHERE email = ?', [userEmail]);
        if (users.length === 0) return res.redirect('/');
        const currentUser = users[0];

        const restaurantId = req.params.id;
        const { book_date, start_time, end_time, guests } = req.body;

        const guestCount = parseInt(guests, 10);
        if (isNaN(guestCount) || guestCount < 1 || guestCount > 20) {
            return res.status(400).send('Invalid number of guests. Must be between 1 and 20.');
        }

        if (start_time >= end_time) {
            return res.status(400).send('Invalid time range: End time must be later than start time.');
        }

        const selectedDate = new Date(book_date);
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const maxAllowedDate = new Date();
        maxAllowedDate.setFullYear(maxAllowedDate.getFullYear() + 1);
        maxAllowedDate.setHours(23, 59, 59, 999);

        if (selectedDate < today) {
            return res.status(400).send('Invalid date: Cannot select a past date.');
        }

        if (selectedDate > maxAllowedDate) {
            return res.status(400).send('Invalid date: Bookings cannot be made more than 1 year in advance.');
        }

        await db.query(`
            INSERT INTO bookings (customer_id, restaurant_id, booking_date, start_time, end_time, guest_count, status) 
            VALUES (?, ?, ?, ?, ?, ?, 'pending')
        `, [currentUser.id, restaurantId, book_date, start_time, end_time, guestCount]);

        res.redirect('/profile?tab=reservations');
    } catch (err) {
        console.error("Ошибка при создании бронирования:", err);
        res.status(500).send('Server error: ' + err.message);
    }
});

app.get('/register', (req, res) => res.redirect('/'));

app.post('/register', async (req, res) => {
    try {
        const { username, email, password, role } = req.body;

        if (!username || !email || !password) {
            return res.status(400).send('All fields are required.');
        }

        const saltRounds = 10;

        bcrypt.hash(password, saltRounds, async (err, hashedPassword) => {
            if (err) {
                console.error('Error hashing password:', err);
                return res.status(500).send('Server error during registration');
            }

            const allowedRoles = ['customer', 'owner'];
            const userRole = allowedRoles.includes(role) ? role : 'customer';

            await db.query(
                'INSERT INTO users (username, email, password, role) VALUES (?, ?, ?, ?)',
                [username, email, hashedPassword, userRole]
            );

            return res.redirect('/?modal=login');
        });

    } catch (err) {
        console.error('Registration failed:', err);
        return res.status(500).send('Server error');
    }
});

app.get('/login', (req, res) => res.redirect('/'));

app.post('/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const [users] = await db.query('SELECT * FROM users WHERE email = ?', [email]);

        if (users.length > 0) {
            const user = users[0];

            if (user.is_blocked) {
                return res.redirect('/?modal=login&error=' + encodeURIComponent('Your account has been blocked'));
            }

            const isPasswordValid = await bcrypt.compare(password, user.password);

            if (isPasswordValid) {
                res.cookie('user_email', email, { maxAge: 24 * 60 * 60 * 1000 });

                if (user.role === 'owner') return res.redirect('/owner-dashboard');
                return res.redirect('/profile');
            }
        }

        res.redirect('/?modal=login&error=' + encodeURIComponent('Invalid email or password!'));

    } catch (err) {
        console.error('Login error:', err);
        res.redirect('/?modal=login&error=' + encodeURIComponent('Server error during login'));
    }
});

app.get('/owner-dashboard', requireRole('owner'), async (req, res) => {
    try {
        const [users] = await db.query('SELECT * FROM users WHERE email = ?', [req.cookies.user_email]);
        const currentUser = users[0];

        let myRestaurants = [];
        try {
            const [rests] = await db.query('SELECT * FROM restaurants WHERE owner_id = ?', [currentUser.id]);
            myRestaurants = rests;
        } catch (e) {
            try {
                const [rests] = await db.query('SELECT * FROM restaurants WHERE user_id = ?', [currentUser.id]);
                myRestaurants = rests;
            } catch (err2) {
                myRestaurants = [];
            }
        }

        const [bookings] = await db.query(`
            SELECT b.id, b.restaurant_id, b.customer_id,
                   DATE_FORMAT(b.booking_date, '%Y-%m-%d') AS booking_date,
                   TIME_FORMAT(b.start_time, '%H:%i') AS start_time,
                   TIME_FORMAT(b.end_time, '%H:%i') AS end_time,
                   b.guest_count, b.status, b.owner_read_at,
                   r.name AS restaurant_name,
                   u.username AS customer_name, u.email AS customer_email, u.avatar AS customer_avatar
            FROM bookings b
            JOIN restaurants r ON r.id = b.restaurant_id
            JOIN users u ON u.id = b.customer_id
            WHERE r.owner_id = ?
            ORDER BY b.booking_date DESC, b.start_time DESC, b.id DESC
        `, [currentUser.id]);

        const [unreadRows] = await db.query(`
            SELECT COUNT(*) AS unread_count
            FROM bookings b
            JOIN restaurants r ON r.id = b.restaurant_id
            WHERE r.owner_id = ? AND b.status = 'pending'
        `, [currentUser.id]);

        const activeTab = req.query.tab === 'reservations' ? 'reservations-tab' : 'profile-tab';

        return res.render('owner-profile', {
            currentUser,
            myRestaurants,
            bookings,
            unreadBookingCount: Number(unreadRows[0].unread_count),
            activeTab,
            stats: { restaurantsCount: myRestaurants.length },
            errorMessage: null,
            addFormData: null
        });
    } catch (err) {
        console.error('Server error on owner dashboard:', err);
        res.status(500).send('Server error on owner dashboard');
    }
});

const ALLOWED_CUISINES = [
    'Italian', 'Japanese', 'Chinese', 'Mexican', 'American',
    'French', 'Indian', 'Thai', 'Korean', 'Turkish',
    'Georgian', 'Mediterranean', 'Spanish', 'Greek', 'Vietnamese',
    'Middle Eastern', 'Brazilian', 'Seafood', 'Steakhouse', 'Fast Food'
];

const ALLOWED_STREETS = [
    'Aethelgard Avenue', 'Borealis Boulevard', 'Caelum Lane', 'Duskwood Crescent',
    'Eldoria Way', 'Faelivor Square', 'Glimmerfen Drive', 'Havencrest Alley',
    'Illoria Passage', 'Jovian Terrace', 'Kinsale Walk', 'LUNARIS Parkway',
    'Mirthwood Row', 'Nebula Circle', 'Oakhaven Loop', 'Pendragon Close',
    'Quicksilver Strand', 'Raventhorpe Thoroughfare', 'Stardust Gate', 'Zephyrion Boulevard'
];

app.post('/owner/restaurants/add', handleRestaurantImageUpload, async (req, res) => {
    try {
        const userEmail = req.cookies.user_email;
        if (!userEmail) return res.redirect('/?modal=login');

        const [users] = await db.query('SELECT * FROM users WHERE email = ?', [userEmail]);
        if (users.length === 0 || users[0].role !== 'owner') return res.redirect('/');
        const currentUser = users[0];

        const { cuisine, street, building_number, image } = req.body || {};

        const renderAddError = async (message) => {
            let myRestaurants = [];
            try {
                const [rests] = await db.query('SELECT * FROM restaurants WHERE owner_id = ?', [currentUser.id]);
                myRestaurants = rests;
            } catch (e) {
                try {
                    const [rests] = await db.query('SELECT * FROM restaurants WHERE user_id = ?', [currentUser.id]);
                    myRestaurants = rests;
                } catch (err2) {
                    myRestaurants = [];
                }
            }

            const [bookings] = await db.query(`
                SELECT b.id, b.restaurant_id, b.customer_id,
                       DATE_FORMAT(b.booking_date, '%Y-%m-%d') AS booking_date,
                       TIME_FORMAT(b.start_time, '%H:%i') AS start_time,
                       TIME_FORMAT(b.end_time, '%H:%i') AS end_time,
                       b.guest_count, b.status, b.owner_read_at,
                       r.name AS restaurant_name,
                       u.username AS customer_name, u.email AS customer_email, u.avatar AS customer_avatar
                FROM bookings b
                JOIN restaurants r ON r.id = b.restaurant_id
                JOIN users u ON u.id = b.customer_id
                WHERE r.owner_id = ?
                ORDER BY b.booking_date DESC, b.start_time DESC, b.id DESC
            `, [currentUser.id]);

            const [unreadRows] = await db.query(`
                SELECT COUNT(*) AS unread_count
                FROM bookings b
                JOIN restaurants r ON r.id = b.restaurant_id
                WHERE r.owner_id = ? AND b.status = 'pending'
            `, [currentUser.id]);

            return res.status(400).render('owner-profile', {
                currentUser,
                myRestaurants,
                bookings,
                unreadBookingCount: Number(unreadRows[0].unread_count),
                activeTab: 'add-restaurant-tab',
                stats: { restaurantsCount: myRestaurants.length },
                errorMessage: message,
                addFormData: {
                    name: typeof req.body?.name === 'string' ? req.body.name : '',
                    cuisine: typeof cuisine === 'string' ? cuisine : '',
                    street: typeof street === 'string' ? street : '',
                    building_number: typeof building_number === 'string' ? building_number : '',
                    description: typeof req.body?.description === 'string' ? req.body.description : '',
                    image: typeof image === 'string' ? image : ''
                }
            });
        };

        const nameCheck = validateTextField(req.body?.name, {
            label: 'Restaurant name',
            required: true,
            min: 2,
            max: 100
        });
        if (!nameCheck.ok) {
            return renderAddError(nameCheck.error);
        }

        const descCheck = validateTextField(req.body?.description, {
            label: 'Restaurant description',
            required: true,
            min: 10,
            max: 1000
        });
        if (!descCheck.ok) {
            return renderAddError(descCheck.error);
        }

        const restaurantCuisine = typeof cuisine === 'string' ? cuisine.trim() : '';
        const restaurantStreet = typeof street === 'string' ? street.trim() : '';
        const buildingNo = parseInt(building_number, 10);

        if (!restaurantCuisine || !restaurantStreet || isNaN(buildingNo)) {
            return renderAddError('Cuisine, street, and building number are required.');
        }

        if (!ALLOWED_CUISINES.includes(restaurantCuisine)) {
            return renderAddError('Please choose a valid cuisine from the list.');
        }

        if (!ALLOWED_STREETS.includes(restaurantStreet)) {
            return renderAddError('Please choose a valid European street from the list.');
        }

        if (buildingNo < 1 || buildingNo > 99) {
            return renderAddError('Building number must be between 1 and 99.');
        }

        const fullAddress = `${restaurantStreet}, ${buildingNo}`;
        if (restaurantCuisine.length > 100 || fullAddress.length > 255) {
            return renderAddError('Cuisine must be at most 100 characters and address at most 255.');
        }

        const imagePath = req.file
            ? '/uploads/' + req.file.filename
            : (typeof image === 'string' && image.trim() ? image.trim() : '/images/No%20image.png');

        await db.query(
            'INSERT INTO restaurants (name, cuisine, address, description, image, owner_id, rating) VALUES (?, ?, ?, ?, ?, ?, 0)',
            [nameCheck.value, restaurantCuisine, fullAddress, descCheck.value, imagePath, currentUser.id]
        );

        return res.redirect('/owner-dashboard');
    } catch (err) {
        console.error('Failed to add restaurant:', err);
        return sendRestaurantError(res, 'Failed to add restaurant', err);
    }
});

app.get('/owner/restaurants/:id/edit', async (req, res) => {
    try {
        const owner = await getOwnerFromRequest(req);
        if (!owner) return res.redirect('/?modal=login');

        const restaurantId = Number(req.params.id);
        if (!Number.isSafeInteger(restaurantId) || restaurantId <= 0) {
            return res.status(404).send('Restaurant not found.');
        }

        const [restaurants] = await db.query(
            'SELECT * FROM restaurants WHERE id = ? AND owner_id = ?',
            [restaurantId, owner.id]
        );
        if (restaurants.length === 0) {
            return res.status(404).send('Restaurant not found or not owned by you.');
        }

        return res.render('owner-edit-restaurant', {
            currentUser: owner,
            restaurant: restaurants[0],
            errorMessage: null
        });
    } catch (err) {
        console.error('Failed to load edit restaurant page:', err);
        return res.status(500).send('Server error');
    }
});

app.post('/owner/restaurants/:id/edit', handleRestaurantImageUpload, async (req, res) => {
    try {
        const owner = await getOwnerFromRequest(req);
        if (!owner) return res.redirect('/?modal=login');

        const restaurantId = Number(req.params.id);
        if (!Number.isSafeInteger(restaurantId) || restaurantId <= 0) {
            return res.status(404).send('Restaurant not found.');
        }

        const [restaurants] = await db.query(
            'SELECT * FROM restaurants WHERE id = ? AND owner_id = ?',
            [restaurantId, owner.id]
        );
        if (restaurants.length === 0) {
            return res.status(404).send('Restaurant not found or not owned by you.');
        }

        const currentRestaurant = restaurants[0];
        const rawName = typeof req.body?.name === 'string' ? req.body.name : '';
        const rawDescription = typeof req.body?.description === 'string' ? req.body.description : '';
        const rawCuisine = typeof req.body?.cuisine === 'string' ? req.body.cuisine.trim() : '';
        const rawStreet = typeof req.body?.street === 'string' ? req.body.street.trim() : '';
        const rawBuilding = req.body?.building_number;
        const parsedBuilding = Number(rawBuilding);

        const renderEditError = (message) => {
            const draftAddress = (rawStreet && Number.isInteger(parsedBuilding) && parsedBuilding >= 1 && parsedBuilding <= 99)
                ? `${rawStreet}, ${parsedBuilding}`
                : currentRestaurant.address;

            return res.status(400).render('owner-edit-restaurant', {
                currentUser: owner,
                restaurant: {
                    ...currentRestaurant,
                    name: rawName,
                    cuisine: rawCuisine,
                    street: rawStreet,
                    building_number: Number.isFinite(parsedBuilding) ? parsedBuilding : '',
                    address: draftAddress,
                    description: rawDescription
                },
                errorMessage: message
            });
        };

        const nameCheck = validateTextField(rawName, {
            label: 'Restaurant name',
            required: true,
            min: 2,
            max: 100
        });
        if (!nameCheck.ok) {
            return renderEditError(nameCheck.error);
        }

        const descCheck = validateTextField(rawDescription, {
            label: 'Restaurant description',
            required: true,
            min: 10,
            max: 1000
        });
        if (!descCheck.ok) {
            return renderEditError(descCheck.error);
        }

        const matchedCuisine = typeof ALLOWED_CUISINES !== 'undefined'
            ? ALLOWED_CUISINES.find((c) => c.toLowerCase() === rawCuisine.toLowerCase())
            : rawCuisine;
        if (!rawCuisine || !matchedCuisine) {
            return renderEditError('Please select a valid cuisine type.');
        }

        const matchedStreet = typeof ALLOWED_STREETS !== 'undefined'
            ? ALLOWED_STREETS.find((s) => s.toLowerCase() === rawStreet.toLowerCase())
            : rawStreet;
        if (!rawStreet || !matchedStreet) {
            return renderEditError('Please select a valid street name.');
        }

        if (!Number.isInteger(parsedBuilding) || parsedBuilding < 1 || parsedBuilding > 99) {
            return renderEditError('Building number must be between 1 and 99.');
        }

        const updatedAddress = `${matchedStreet}, ${parsedBuilding}`;
        const imagePath = req.file ? '/uploads/' + req.file.filename : currentRestaurant.image;

        await db.query(
            'UPDATE restaurants SET name = ?, cuisine = ?, address = ?, description = ?, image = ? WHERE id = ? AND owner_id = ?',
            [nameCheck.value, matchedCuisine, updatedAddress, descCheck.value, imagePath, restaurantId, owner.id]
        );

        return res.redirect('/owner-dashboard');
    } catch (err) {
        console.error('Failed to update restaurant:', err);
        return sendRestaurantError(res, 'Failed to update restaurant', err);
    }
});

app.post('/owner/restaurants/delete/:id', async (req, res) => {
    try {
        const userEmail = req.cookies.user_email;
        if (!userEmail) return res.redirect('/?modal=login');

        const [users] = await db.query('SELECT id, role FROM users WHERE email = ?', [userEmail]);
        if (users.length === 0 || users[0].role !== 'owner') return res.redirect('/');

        const restaurantId = Number(req.params.id);
        if (!Number.isSafeInteger(restaurantId) || restaurantId <= 0) {
            return res.status(400).send('Invalid restaurant ID.');
        }

        const [mine] = await db.query(
            'SELECT id FROM restaurants WHERE id = ? AND owner_id = ?',
            [restaurantId, users[0].id]
        );

        if (mine.length === 0) {
            return res.status(404).send('Restaurant not found or not owned by this account.');
        }

        await deleteRestaurantCascade(restaurantId);

        return res.redirect('/owner-dashboard');
    } catch (err) {
        console.error('Failed to delete restaurant:', err);
        return sendRestaurantError(res, 'Failed to delete restaurant', err);
    }
});

app.post('/owner/restaurants/:id/delete-image', async (req, res) => {
    try {
        const owner = await getOwnerFromRequest(req);
        if (!owner) return res.redirect('/?modal=login');

        const restaurantId = Number(req.params.id);
        if (!Number.isSafeInteger(restaurantId) || restaurantId <= 0) {
            return res.status(404).send('Restaurant not found.');
        }

        const [restaurants] = await db.query(
            'SELECT * FROM restaurants WHERE id = ? AND owner_id = ?',
            [restaurantId, owner.id]
        );
        if (restaurants.length === 0) {
            return res.status(404).send('Restaurant not found or not owned by you.');
        }

        await db.query(
            'UPDATE restaurants SET image = NULL WHERE id = ? AND owner_id = ?',
            [restaurantId, owner.id]
        );

        return res.redirect(`/owner/restaurants/${restaurantId}/edit`);
    } catch (err) {
        console.error('Failed to remove restaurant image:', err);
        return sendRestaurantError(res, 'Failed to remove restaurant image', err);
    }
});

app.get('/owner/restaurants/:id/menu', async (req, res) => {
    try {
        const owner = await getOwnerFromRequest(req);
        if (!owner) return res.redirect('/?modal=login');

        const restaurantId = Number(req.params.id);
        if (!Number.isSafeInteger(restaurantId) || restaurantId <= 0) {
            return res.status(404).send('Restaurant not found.');
        }

        const [restaurants] = await db.query(
            'SELECT * FROM restaurants WHERE id = ? AND owner_id = ?',
            [restaurantId, owner.id]
        );
        if (restaurants.length === 0) return res.status(404).send('Restaurant not found.');

        const [menuItems] = await db.query(
            'SELECT * FROM menu_items WHERE restaurant_id = ? ORDER BY id ASC',
            [restaurantId]
        );

        const messages = {
            added: 'Menu item added.',
            updated: 'Menu item updated.',
            deleted: 'Menu item deleted.'
        };

        return res.render('owner-menu', {
            currentUser: owner,
            restaurant: restaurants[0],
            menuItems,
            statusMessage: messages[req.query.status] || null,
            errorMessage: null,
            failedUpdateItem: null,
            addMenuItemData: null
        });
    } catch (err) {
        console.error('Failed to load restaurant menu:', err);
        return sendRestaurantError(res, 'Failed to load menu', err);
    }
});

app.post('/owner/restaurants/:restaurantId/menu/add', async (req, res) => {
    try {
        const owner = await getOwnerFromRequest(req);
        if (!owner) return res.redirect('/?modal=login');

        const restaurantId = Number(req.params.restaurantId);
        if (!Number.isSafeInteger(restaurantId) || restaurantId <= 0) {
            return res.status(404).send('Restaurant not found.');
        }

        const [restaurants] = await db.query(
            'SELECT * FROM restaurants WHERE id = ? AND owner_id = ?',
            [restaurantId, owner.id]
        );
        if (restaurants.length === 0) return res.status(404).send('Restaurant not found.');

        const rawName = typeof req.body?.name === 'string' ? req.body.name : '';
        const rawDescription = typeof req.body?.description === 'string' ? req.body.description : '';
        const rawPrice = typeof req.body?.price === 'string' ? req.body.price : '';

        const renderMenuError = async (message) => {
            const [menuItems] = await db.query(
                'SELECT * FROM menu_items WHERE restaurant_id = ? ORDER BY id ASC',
                [restaurantId]
            );
            return res.status(400).render('owner-menu', {
                currentUser: owner,
                restaurant: restaurants[0],
                menuItems,
                statusMessage: null,
                errorMessage: message,
                failedUpdateItem: null,
                addMenuItemData: {
                    name: rawName,
                    description: rawDescription,
                    price: rawPrice
                }
            });
        };

        const nameCheck = validateTextField(rawName, { label: 'Dish name', required: true, min: 2, max: 100 });
        if (!nameCheck.ok) {
            return renderMenuError(nameCheck.error);
        }

        const descCheck = validateTextField(rawDescription || '', { label: 'Dish description', required: false, min: 0, max: 500 });
        if (!descCheck.ok) {
            return renderMenuError(descCheck.error);
        }

        const priceText = rawPrice.trim();
        if (!/^\d+(?:\.\d{1,2})?$/.test(priceText)) {
            return renderMenuError('Enter a valid non-negative price with up to two decimals.');
        }

        const price = Number(priceText);
        if (!Number.isFinite(price) || price > 99999999.99) {
            return renderMenuError('Price is outside the allowed range.');
        }

        await db.query(
            'INSERT INTO menu_items (restaurant_id, name, description, price) VALUES (?, ?, ?, ?)',
            [restaurantId, nameCheck.value, descCheck.value || null, price]
        );

        return res.redirect(`/owner/restaurants/${restaurantId}/menu?status=added`);
    } catch (err) {
        console.error('Failed to add menu item:', err);
        return sendRestaurantError(res, 'Failed to add menu item', err);
    }
});

app.post('/owner/restaurants/:restaurantId/menu/:itemId/update', async (req, res) => {
    try {
        const owner = await getOwnerFromRequest(req);
        if (!owner) return res.redirect('/?modal=login');

        const restaurantId = Number(req.params.restaurantId);
        const itemId = Number(req.params.itemId);
        if (!Number.isSafeInteger(restaurantId) || restaurantId <= 0 || !Number.isSafeInteger(itemId) || itemId <= 0) {
            return res.status(404).send('Restaurant or menu item not found.');
        }

        const [restaurants] = await db.query(
            'SELECT * FROM restaurants WHERE id = ? AND owner_id = ?',
            [restaurantId, owner.id]
        );
        if (restaurants.length === 0) return res.status(404).send('Restaurant not found.');

        const rawName = typeof req.body?.name === 'string' ? req.body.name : '';
        const rawDescription = typeof req.body?.description === 'string' ? req.body.description : '';
        const rawPrice = typeof req.body?.price === 'string' ? req.body.price : '';

        const renderMenuError = async (message) => {
            const [menuItems] = await db.query(
                'SELECT * FROM menu_items WHERE restaurant_id = ? ORDER BY id ASC',
                [restaurantId]
            );
            return res.status(400).render('owner-menu', {
                currentUser: owner,
                restaurant: restaurants[0],
                menuItems,
                statusMessage: null,
                errorMessage: message,
                failedUpdateItem: {
                    itemId,
                    name: rawName,
                    description: rawDescription,
                    price: rawPrice
                }
            });
        };

        const nameCheck = validateTextField(rawName, {
            label: 'Dish name',
            required: true,
            min: 2,
            max: 100
        });
        if (!nameCheck.ok) {
            return renderMenuError(nameCheck.error);
        }

        const descCheck = validateTextField(rawDescription || '', {
            label: 'Dish description',
            required: false,
            min: 0,
            max: 500
        });
        if (!descCheck.ok) {
            return renderMenuError(descCheck.error);
        }

        const priceText = rawPrice.trim();
        if (!/^\d+(?:\.\d{1,2})?$/.test(priceText)) {
            return renderMenuError('Check the item price.');
        }

        const price = Number(priceText);
        if (!Number.isFinite(price) || price > 99999999.99) {
            return renderMenuError('Price is outside the allowed range.');
        }

        const [items] = await db.query(
            'SELECT id FROM menu_items WHERE id = ? AND restaurant_id = ?',
            [itemId, restaurantId]
        );
        if (items.length === 0) return res.status(404).send('Menu item not found.');

        await db.query(
            'UPDATE menu_items SET name = ?, description = ?, price = ? WHERE id = ? AND restaurant_id = ?',
            [nameCheck.value, descCheck.value || null, price, itemId, restaurantId]
        );

        return res.redirect(`/owner/restaurants/${restaurantId}/menu?status=updated`);
    } catch (err) {
        console.error('Failed to update menu item:', err);
        return sendRestaurantError(res, 'Failed to update menu item', err);
    }
});

app.post('/owner/restaurants/:restaurantId/menu/:itemId/delete', async (req, res) => {
    try {
        const owner = await getOwnerFromRequest(req);
        if (!owner) return res.redirect('/?modal=login');

        const restaurantId = Number(req.params.restaurantId);
        const itemId = Number(req.params.itemId);
        if (!Number.isSafeInteger(restaurantId) || restaurantId <= 0 || !Number.isSafeInteger(itemId) || itemId <= 0) {
            return res.status(404).send('Restaurant or menu item not found.');
        }

        const [restaurants] = await db.query(
            'SELECT id FROM restaurants WHERE id = ? AND owner_id = ?',
            [restaurantId, owner.id]
        );
        if (restaurants.length === 0) return res.status(404).send('Restaurant not found.');

        const [result] = await db.query(
            'DELETE FROM menu_items WHERE id = ? AND restaurant_id = ?',
            [itemId, restaurantId]
        );
        if (result.affectedRows === 0) return res.status(404).send('Menu item not found.');

        return res.redirect(`/owner/restaurants/${restaurantId}/menu?status=deleted`);
    } catch (err) {
        console.error('Failed to delete menu item:', err);
        return sendRestaurantError(res, 'Failed to delete menu item', err);
    }
});

app.get('/owner/bookings/notifications', async (req, res) => {
    try {
        const owner = await getOwnerFromRequest(req);
        if (!owner) return res.status(401).json({ error: 'Owner login required.' });

        const [counts] = await db.query(`
            SELECT COUNT(*) AS unread_count
            FROM bookings b
            JOIN restaurants r ON r.id = b.restaurant_id
            WHERE r.owner_id = ? AND b.owner_read_at IS NULL
        `, [owner.id]);
        const [latestRows] = await db.query(`
            SELECT b.id, r.name AS restaurantName, u.username AS customerName
            FROM bookings b
            JOIN restaurants r ON r.id = b.restaurant_id
            JOIN users u ON u.id = b.customer_id
            WHERE r.owner_id = ? AND b.owner_read_at IS NULL
            ORDER BY b.created_at DESC, b.id DESC
            LIMIT 1
        `, [owner.id]);

        return res.json({
            unreadCount: Number(counts[0].unread_count),
            latest: latestRows[0] || null
        });
    } catch (err) {
        console.error('Failed to fetch booking notifications:', err);
        return res.status(500).json({ error: 'Could not load booking notifications.' });
    }
});

app.post('/owner/bookings/read-all', async (req, res) => {
    try {
        const owner = await getOwnerFromRequest(req);
        if (!owner) return res.status(401).json({ error: 'Owner login required.' });

        await db.query(`
            UPDATE bookings b
            JOIN restaurants r ON r.id = b.restaurant_id
            SET b.owner_read_at = CURRENT_TIMESTAMP
            WHERE r.owner_id = ? AND b.owner_read_at IS NULL
        `, [owner.id]);
        return res.json({ success: true });
    } catch (err) {
        console.error('Failed to mark booking notifications as read:', err);
        return res.status(500).json({ error: 'Could not update booking notifications.' });
    }
});

app.post('/owner/bookings/:id/status', async (req, res) => {
    try {
        const userEmail = req.cookies.user_email;
        if (!userEmail) return res.redirect('/?modal=login');

        const bookingId = req.params.id;
        const { status } = req.body;

        if (status !== 'confirmed' && status !== 'cancelled') {
            return res.status(400).send('Invalid status');
        }

        await db.query(`
            UPDATE bookings 
            SET status = ? 
            WHERE id = ?
        `, [status, bookingId]);

        res.redirect('/owner-dashboard?tab=reservations');
    } catch (err) {
        console.error("Ошибка при обновлении статуса:", err);
        res.status(500).send('Server error: ' + err.message);
    }
});

app.post('/owner/bookings/:id/delete', async (req, res) => {
    try {
        const userEmail = req.cookies.user_email;
        if (!userEmail) return res.redirect('/?modal=login');

        const bookingId = req.params.id;

        await db.query(`
            DELETE FROM bookings 
            WHERE id = ?
        `, [bookingId]);

        res.redirect('/owner-dashboard?tab=reservations');
    } catch (err) {
        console.error("Ошибка при удалении бронирования владельцем:", err);
        res.status(500).send('Server error: ' + err.message);
    }
});

app.get('/admin', async (req, res) => {
    try {
        const userEmail = req.cookies.user_email;
        let currentUser = null;
        if (userEmail) {
            const [users] = await db.query('SELECT * FROM users WHERE email = ?', [userEmail]);
            if (users.length > 0) currentUser = users[0];
        }

        if (currentUser && currentUser.role === 'admin') {
            const [allUsers] = await db.query('SELECT * FROM users');
            const [allRestaurants] = await db.query('SELECT * FROM restaurants');
            const [allReviews] = await db.query(`
                SELECT reviews.*, users.username, restaurants.name as restaurant_name 
                FROM reviews JOIN users ON reviews.user_id = users.id 
                JOIN restaurants ON reviews.restaurant_id = restaurants.id
            `);
            return res.render('admin', { currentUser, users: allUsers, restaurants: allRestaurants, reviews: allReviews });
        }
        res.render('admin-login', { error: null, currentUser: null });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    }
});

app.post('/admin', async (req, res) => {
    const { email, password } = req.body;
    try {
        const [users] = await db.query('SELECT * FROM users WHERE email = ? AND password = ? AND role = "admin"', [email, password]);
        if (users.length > 0) {
            if (users[0].is_blocked) {
                return res.render('admin-login', { error: 'Your account has been blocked.', currentUser: null });
            }

            res.cookie('user_email', email, { maxAge: 24 * 60 * 60 * 1000 });
            res.redirect('/admin');
        } else {
            res.render('admin-login', { error: 'Invalid admin credentials!', currentUser: null });
        }
    } catch (err) {
        console.error(err);
        res.render('admin-login', { error: 'Server error', currentUser: null });
    }
});

app.post('/admin/users/delete/:id', async (req, res) => {
    try {
        const userEmail = req.cookies.user_email;
        if (!userEmail) return res.redirect('/admin');
        const [adminCheck] = await db.query('SELECT * FROM users WHERE email = ? AND role = "admin"', [userEmail]);
        if (adminCheck.length === 0 || adminCheck[0].id == req.params.id) return res.redirect('/admin');

        const userId = Number(req.params.id);
        if (!Number.isSafeInteger(userId) || userId <= 0) return res.redirect('/admin');

        await deleteUserCascade(userId);
        res.redirect('/admin');
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    }
});

app.post('/admin/users/toggle/:id', async (req, res) => {
    try {
        const userEmail = req.cookies.user_email;
        if (!userEmail) return res.redirect('/admin');
        const [adminCheck] = await db.query('SELECT * FROM users WHERE email = ? AND role = "admin"', [userEmail]);
        if (adminCheck.length === 0 || adminCheck[0].id == req.params.id) return res.redirect('/admin');

        const [targetUser] = await db.query('SELECT is_blocked FROM users WHERE id = ?', [req.params.id]);
        if (targetUser.length > 0) {
            await db.query('UPDATE users SET is_blocked = ? WHERE id = ?', [targetUser[0].is_blocked ? 0 : 1, req.params.id]);
        }
        res.redirect('/admin');
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    }
});

app.post('/admin/restaurants/toggle/:id', async (req, res) => {
    try {
        const userEmail = req.cookies.user_email;
        const [adminCheck] = await db.query('SELECT * FROM users WHERE email = ? AND role = "admin"', [userEmail]);
        if (adminCheck.length === 0) return res.redirect('/');

        const [targetRest] = await db.query('SELECT is_hidden FROM restaurants WHERE id = ?', [req.params.id]);
        if (targetRest.length > 0) {
            await db.query('UPDATE restaurants SET is_hidden = ? WHERE id = ?', [targetRest[0].is_hidden ? 0 : 1, req.params.id]);
        }
        res.redirect('/admin');
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    }
});

app.post('/admin/restaurants/delete/:id', async (req, res) => {
    try {
        const userEmail = req.cookies.user_email;
        const [adminCheck] = await db.query('SELECT * FROM users WHERE email = ? AND role = "admin"', [userEmail]);
        if (adminCheck.length === 0) return res.redirect('/');

        const restaurantId = Number(req.params.id);
        if (!Number.isSafeInteger(restaurantId) || restaurantId <= 0) return res.redirect('/admin');

        const [target] = await db.query('SELECT name, owner_id FROM restaurants WHERE id = ?', [restaurantId]);

        await deleteRestaurantCascade(restaurantId);

        if (target.length > 0 && target[0].owner_id) {
            await addNotification(
                target[0].owner_id,
                'restaurant_deleted',
                `Your restaurant "${target[0].name}" was deleted by an administrator for violating the service rules.`
            );
        }

        res.redirect('/admin');
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    }
});

app.post('/admin/reviews/toggle/:id', async (req, res) => {
    try {
        const userEmail = req.cookies.user_email;
        const [adminCheck] = await db.query('SELECT * FROM users WHERE email = ? AND role = "admin"', [userEmail]);
        if (adminCheck.length === 0) return res.redirect('/');

        const reviewId = Number(req.params.id);
        if (!Number.isSafeInteger(reviewId) || reviewId <= 0) return res.redirect('/admin');

        const [targetRev] = await db.query('SELECT is_hidden, restaurant_id FROM reviews WHERE id = ?', [reviewId]);

        if (targetRev.length > 0) {
            const newHiddenStatus = targetRev[0].is_hidden ? 0 : 1;
            const restaurantId = targetRev[0].restaurant_id;

            await db.query('UPDATE reviews SET is_hidden = ? WHERE id = ?', [newHiddenStatus, reviewId]);

            await recalcRestaurantRating(restaurantId);
        }

        res.redirect('/admin');
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    }
});

app.post('/admin/reviews/delete/:id', async (req, res) => {
    try {
        const userEmail = req.cookies.user_email;
        const [adminCheck] = await db.query('SELECT * FROM users WHERE email = ? AND role = "admin"', [userEmail]);
        if (adminCheck.length === 0) return res.redirect('/');

        const [target] = await db.query(`
            SELECT reviews.user_id, reviews.restaurant_id, restaurants.name AS restaurant_name
            FROM reviews
            JOIN restaurants ON reviews.restaurant_id = restaurants.id
            WHERE reviews.id = ?
        `, [req.params.id]);

        await db.query('DELETE FROM reviews WHERE id = ?', [req.params.id]);

        if (target.length > 0) {
            await recalcRestaurantRating(target[0].restaurant_id);

            await addNotification(
                target[0].user_id,
                'review_deleted',
                `Your review of "${target[0].restaurant_name}" was deleted by an administrator for violating the service rules.`
            );
        }

        res.redirect('/admin');
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    }
});

app.get('/logout', (req, res) => {
    res.clearCookie('user_email');
    res.redirect('/');
});

app.post('/profile/bookings/edit/:id', async (req, res) => {
    try {
        const userEmail = req.cookies.user_email;
        if (!userEmail) return res.redirect('/?modal=login');

        const [users] = await db.query('SELECT * FROM users WHERE email = ?', [userEmail]);
        if (users.length === 0) return res.redirect('/');
        const currentUser = users[0];

        const bookingId = req.params.id;
        const { book_date, start_time, end_time, guests } = req.body;

        const [bookings] = await db.query(`
            SELECT * FROM bookings 
            WHERE id = ? AND customer_id = ?
        `, [bookingId, currentUser.id]);

        if (bookings.length === 0) {
            return res.status(404).send('Booking not found');
        }

        if (bookings[0].status === 'confirmed') {
            return res.status(403).send('Action forbidden: Confirmed bookings cannot be edited.');
        }

        const guestCount = parseInt(guests, 10);
        if (isNaN(guestCount) || guestCount < 1 || guestCount > 20) {
            return res.status(400).send('Invalid number of guests. Must be between 1 and 20.');
        }

        if (start_time >= end_time) {
            return res.status(400).send('Invalid time range: End time must be later than start time.');
        }

        const selectedDate = new Date(book_date);
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const maxAllowedDate = new Date();
        maxAllowedDate.setFullYear(maxAllowedDate.getFullYear() + 1);
        maxAllowedDate.setHours(23, 59, 59, 999);

        if (selectedDate < today) {
            return res.status(400).send('Invalid date: Cannot select a past date.');
        }

        if (selectedDate > maxAllowedDate) {
            return res.status(400).send('Invalid date: Bookings cannot be made more than 1 year in advance.');
        }

        await db.query(`
            UPDATE bookings 
            SET booking_date = ?, start_time = ?, end_time = ?, guest_count = ? 
            WHERE id = ? AND customer_id = ?
        `, [book_date, start_time, end_time, guestCount, bookingId, currentUser.id]);

        res.redirect('/profile?tab=reservations');
    } catch (err) {
        console.error("Ошибка при редактировании бронирования:", err);
        res.status(500).send('Server error: ' + err.message);
    }
});

app.post('/profile/reviews/delete/:id', async (req, res) => {
    try {
        const userEmail = req.cookies.user_email;
        if (!userEmail) return res.redirect('/?modal=login');

        const [users] = await db.query('SELECT id, role FROM users WHERE email = ?', [userEmail]);
        if (users.length === 0 || users[0].role !== 'customer') {
            return res.status(403).send('Access denied.');
        }

        const reviewId = Number(req.params.id);
        if (!Number.isSafeInteger(reviewId) || reviewId <= 0) {
            return res.status(400).send('Invalid review ID.');
        }

        const [target] = await db.query('SELECT restaurant_id FROM reviews WHERE id = ? AND user_id = ?', [reviewId, users[0].id]);
        if (target.length === 0) {
            return res.status(404).send('Review not found or not owned by you.');
        }

        const restaurantId = target[0].restaurant_id;

        await db.query('DELETE FROM reviews WHERE id = ?', [reviewId]);

        await recalcRestaurantRating(restaurantId);

        return res.redirect('/profile?tab=reviews');
    } catch (err) {
        console.error('Failed to delete review:', err);
        return res.status(500).send('Server error during review deletion');
    }
});

app.post('/profile/reviews/edit/:id', async (req, res) => {
    try {
        const userEmail = req.cookies.user_email;
        if (!userEmail) return res.redirect('/?modal=login');

        const [users] = await db.query('SELECT id, role FROM users WHERE email = ?', [userEmail]);
        if (users.length === 0 || users[0].role !== 'customer') {
            return res.status(403).send('Access denied.');
        }

        const reviewId = Number(req.params.id);
        const rating = Number(req.body.rating);
        const comment = typeof req.body.comment === 'string' ? req.body.comment.trim() : '';

        if (!Number.isInteger(rating) || rating < 1 || rating > 5 || !comment) {
            return res.status(400).send('Invalid rating or comment.');
        }

        const [target] = await db.query('SELECT restaurant_id FROM reviews WHERE id = ? AND user_id = ?', [reviewId, users[0].id]);
        if (target.length === 0) {
            return res.status(404).send('Review not found or not owned by you.');
        }

        const restaurantId = target[0].restaurant_id;

        await db.query('UPDATE reviews SET rating = ?, comment = ? WHERE id = ?', [rating, comment, reviewId]);

        await recalcRestaurantRating(restaurantId);

        return res.redirect('/profile?tab=reviews');
    } catch (err) {
        console.error('Failed to update review:', err);
        return res.status(500).send('Server error during review update');
    }
});

app.post('/profile/reviews/toggle/:id', async (req, res) => {
    try {
        const userEmail = req.cookies.user_email;
        if (!userEmail) return res.redirect('/?modal=login');

        const [users] = await db.query('SELECT id, role FROM users WHERE email = ?', [userEmail]);
        if (users.length === 0 || users[0].role !== 'customer') {
            return res.status(403).send('Access denied.');
        }

        const reviewId = Number(req.params.id);
        const [target] = await db.query('SELECT id, restaurant_id, is_hidden FROM reviews WHERE id = ? AND user_id = ?', [reviewId, users[0].id]);
        if (target.length === 0) {
            return res.status(404).send('Review not found.');
        }

        const restaurantId = target[0].restaurant_id;
        const newHiddenState = target[0].is_hidden ? 0 : 1;

        await db.query('UPDATE reviews SET is_hidden = ? WHERE id = ?', [newHiddenState, reviewId]);

        await recalcRestaurantRating(restaurantId);

        return res.redirect('/profile?tab=reviews');
    } catch (err) {
        console.error('Failed to toggle review visibility:', err);
        return res.status(500).send('Server error');
    }
});

app.post('/profile/bookings/delete/:id', async (req, res) => {
    try {
        const userEmail = req.cookies.user_email;
        if (!userEmail) return res.redirect('/?modal=login');

        const [users] = await db.query('SELECT * FROM users WHERE email = ?', [userEmail]);
        if (users.length === 0) return res.redirect('/');
        const currentUser = users[0];

        const bookingId = req.params.id;

        await db.query(`
            DELETE FROM bookings 
            WHERE id = ? AND customer_id = ?
        `, [bookingId, currentUser.id]);

        res.redirect('/profile?tab=reservations');
    } catch (err) {
        console.error("Ошибка при удалении бронирования клиентом:", err);
        res.status(500).send('Server error: ' + err.message);
    }
});

app.get('/profile', isAuthenticated, async (req, res) => {
    try {
        const userEmail = req.cookies.user_email;

        const [users] = await db.query('SELECT * FROM users WHERE email = ?', [userEmail]);
        if (users.length === 0) {
            res.clearCookie('user_email');
            return res.redirect('/?modal=login');
        }
        const currentUser = users[0];

        if (currentUser.role === 'owner') {
            return res.redirect('/owner-dashboard');
        }

        const [myReviews] = await db.query(`
            SELECT reviews.*, restaurants.name as restaurant_name 
            FROM reviews 
            JOIN restaurants ON reviews.restaurant_id = restaurants.id 
            WHERE reviews.user_id = ? 
            ORDER BY reviews.id DESC
        `, [currentUser.id]);

        let favorites = [];
        try {
            const [favs] = await db.query(`
                SELECT restaurants.* 
                FROM favorites 
                JOIN restaurants ON favorites.restaurant_id = restaurants.id 
                WHERE favorites.user_id = ? AND (restaurants.is_hidden = 0 OR restaurants.is_hidden IS NULL)
            `, [currentUser.id]);
            favorites = favs;
        } catch (e) {
            favorites = [];
        }

        let myBookings = [];
        try {
            const [bookingsResult] = await db.query(`
                SELECT b.*, r.name AS restaurant_name, r.image AS restaurant_image, 
                       COALESCE(AVG(rev.rating), r.rating) AS restaurant_rating 
                FROM bookings b 
                JOIN restaurants r ON b.restaurant_id = r.id 
                LEFT JOIN reviews rev ON r.id = rev.restaurant_id AND (rev.is_hidden = 0 OR rev.is_hidden IS NULL) 
                WHERE b.customer_id = ? 
                GROUP BY b.id, r.id, r.name, r.image, r.rating 
                ORDER BY b.booking_date DESC, b.start_time DESC
            `, [currentUser.id]);
            myBookings = bookingsResult;
        } catch (e) {
            myBookings = [];
        }

        const activeTab = req.query.tab === 'favorites' ? 'favorites-tab' :
            (req.query.tab === 'reviews' ? 'reviews-tab' :
                (req.query.tab === 'reservations' ? 'reservations-tab' :
                    (req.query.tab === 'security' ? 'security-tab' : 'profile-tab')));

        res.render('profile', {
            currentUser,
            myReviews,
            favorites,
            myBookings,
            activeTab,
            stats: { ratedCount: myReviews.length }
        });

    } catch (err) {
        console.error('Profile route error:', err);
        res.status(500).send('Server error');
    }
});

app.post('/profile/update', upload.single('avatarFile'), async (req, res) => {
    try {
        const userEmail = req.cookies.user_email;
        if (!userEmail) return res.redirect('/');

        const [users] = await db.query('SELECT * FROM users WHERE email = ?', [userEmail]);
        if (users.length === 0) return res.redirect('/');
        const currentUser = users[0];

        let avatarPath = currentUser.avatar;
        if (req.file) avatarPath = '/uploads/' + req.file.filename;

        await db.query('UPDATE users SET username = ?, avatar = ? WHERE email = ?', [req.body.username, avatarPath, userEmail]);

        if (currentUser.role === 'admin') return res.redirect('/admin');

        res.redirect('/profile');
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error during profile update');
    }
});

app.post('/profile/avatar/delete', async (req, res) => {
    try {
        const userEmail = req.cookies.user_email;
        if (!userEmail) return res.redirect('/?modal=login');

        const [users] = await db.query('SELECT role FROM users WHERE email = ?', [userEmail]);
        if (users.length === 0) return res.redirect('/');

        await db.query('UPDATE users SET avatar = NULL WHERE email = ?', [userEmail]);

        if (users[0].role === 'owner') {
            return res.redirect('/owner-dashboard');
        }
        if (users[0].role === 'admin') {
            return res.redirect('/admin');
        }
        return res.redirect('/profile');
    } catch (err) {
        console.error('Failed to delete avatar:', err);
        res.status(500).send('Server error during avatar deletion');
    }
});

app.post('/profile/security', async (req, res) => {
    try {
        const userEmail = req.cookies.user_email;
        const { newPassword } = req.body;
        if (!userEmail) return res.redirect('/');
        if (!newPassword || newPassword.trim() === '') return res.redirect('/profile?error=' + encodeURIComponent('Password cannot be empty!'));

        await db.query('UPDATE users SET password = ? WHERE email = ?', [newPassword, userEmail]);
        res.redirect('/profile?success=' + encodeURIComponent('Password updated!'));
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    }
});

async function renderNotificationsPage(req, res, requiredRole) {
    try {
        const userEmail = req.cookies.user_email;
        if (!userEmail) return res.redirect('/?modal=login');

        const [users] = await db.query('SELECT * FROM users WHERE email = ?', [userEmail]);
        if (users.length === 0 || users[0].role !== requiredRole) return res.redirect('/');
        const currentUser = users[0];

        const notifications = await getNotificationsForUser(currentUser);
        return res.render('notifications', { currentUser, notifications });
    } catch (err) {
        console.error('Failed to load notifications page:', err);
        return res.status(500).send('Server error');
    }
}

app.get('/owner-notifications', (req, res) => renderNotificationsPage(req, res, 'owner'));

app.get('/customer-notifications', (req, res) => renderNotificationsPage(req, res, 'customer'));

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running at: http://localhost:${PORT}`);
});