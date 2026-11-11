const multer = require('multer');
const path = require('path');
const fs = require('fs');

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

app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

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
        const [topRestaurants] = await db.query('SELECT * FROM restaurants ORDER BY rating DESC LIMIT 3');
        const [recentReviews] = await db.query(`
            SELECT reviews.*, users.username, restaurants.name as restaurant_name 
            FROM reviews 
            JOIN users ON reviews.user_id = users.id 
            JOIN restaurants ON reviews.restaurant_id = restaurants.id 
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
        const conditions = ['(is_hidden = 0 OR is_hidden IS NULL)'];
        const params = [];

        if (rawQuery) {
            conditions.push('(name LIKE ? OR cuisine LIKE ? OR address LIKE ?)');
            const term = `%${rawQuery}%`;
            params.push(term, term, term);
        }
        if (selectedCuisine) {
            conditions.push('cuisine = ?');
            params.push(selectedCuisine);
        }

        const [restaurants] = await db.query(
            `SELECT * FROM restaurants WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC, id DESC`,
            params
        );
        const [cuisines] = await db.query(`
            SELECT DISTINCT cuisine
            FROM restaurants
            WHERE is_hidden = 0 OR is_hidden IS NULL
            ORDER BY cuisine ASC
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
            currentUser
        });
    } catch (err) {
        console.error('Failed to load restaurants:', err);
        return res.status(500).send('Could not load restaurants.');
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
        if (req.cookies.user_email) {
            const [users] = await db.query(
                'SELECT id, username, email, role, avatar FROM users WHERE email = ?',
                [req.cookies.user_email]
            );
            if (users.length > 0) currentUser = users[0];
        }

        return res.render('restaurant-detail', {
            restaurant: restaurants[0],
            reviews,
            menuItems,
            currentUser,
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
        const restaurantId = Number(req.params.id);
        if (!Number.isSafeInteger(restaurantId) || restaurantId <= 0) {
            return res.status(404).send('Restaurant not found.');
        }

        const userEmail = req.cookies.user_email;
        if (!userEmail) return res.redirect('/?modal=login');

        const [users] = await db.query(
            'SELECT id, role FROM users WHERE email = ?',
            [userEmail]
        );
        if (users.length === 0 || users[0].role !== 'customer') {
            return res.status(403).send('Please sign in with a customer account to make a booking.');
        }

        const [restaurants] = await db.query(
            'SELECT id FROM restaurants WHERE id = ? AND (is_hidden = 0 OR is_hidden IS NULL)',
            [restaurantId]
        );
        if (restaurants.length === 0) return res.status(404).send('Restaurant not found.');

        const { book_date: bookingDate, start_time: startTime, end_time: endTime } = req.body;
        const guestCount = Number(req.body.guests);
        if (!isValidBookingDate(bookingDate) || !isValidBookingTime(startTime) ||
            !isValidBookingTime(endTime) || endTime <= startTime ||
            !Number.isInteger(guestCount) || guestCount < 1 || guestCount > 20) {
            return res.redirect(`/restaurant/${restaurantId}?booking=invalid`);
        }

        await db.query(
            `INSERT INTO bookings
                (restaurant_id, customer_id, booking_date, start_time, end_time, guest_count, status)
             VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
            [restaurantId, users[0].id, bookingDate, startTime, endTime, guestCount]
        );

        return res.redirect(`/restaurant/${restaurantId}?booking=sent`);
    } catch (err) {
        console.error('Failed to create booking:', err);
        const restaurantId = Number(req.params.id);
        if (Number.isSafeInteger(restaurantId) && restaurantId > 0) {
            return res.redirect(`/restaurant/${restaurantId}?booking=failed`);
        }
        return res.status(500).send('Could not save this booking.');
    }
});

app.get('/register', (req, res) => res.redirect('/'));

app.post('/register', async (req, res) => {
    const { username, email, password, role } = req.body;
    try {
        const assignedRole = (role === 'owner') ? 'owner' : 'customer';
        await db.query('INSERT INTO users (username, email, password, role, avatar) VALUES (?, ?, ?, ?, NULL)',
            [username, email, password, assignedRole]);
        res.cookie('user_email', email, { maxAge: 24 * 60 * 60 * 1000 });
        res.redirect('/');
    } catch (err) {
        console.error(err);
        res.redirect('/?modal=register&error=' + encodeURIComponent('User exists or error occurred!'));
    }
});

app.get('/login', (req, res) => res.redirect('/'));

app.post('/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const [users] = await db.query('SELECT * FROM users WHERE email = ? AND password = ?', [email, password]);
        if (users.length > 0) {
            res.cookie('user_email', email, { maxAge: 24 * 60 * 60 * 1000 });
            if (users[0].role === 'owner') return res.redirect('/owner-dashboard');
            if (users[0].role === 'admin') return res.redirect('/admin');
            return res.redirect('/profile');
        } else {
            res.redirect('/?modal=login&error=' + encodeURIComponent('Invalid email or password!'));
        }
    } catch (err) {
        console.error(err);
        res.redirect('/?modal=login&error=' + encodeURIComponent('Server error during login'));
    }
});

app.get('/owner-dashboard', async (req, res) => {
    try {
        const userEmail = req.cookies.user_email;
        if (!userEmail) return res.redirect('/?modal=login');

        const [users] = await db.query('SELECT * FROM users WHERE email = ?', [userEmail]);
        if (users.length === 0 || users[0].role !== 'owner') return res.redirect('/');
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
                   r.name AS restaurant_name, u.username AS customer_name, u.email AS customer_email
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
            WHERE r.owner_id = ? AND b.owner_read_at IS NULL
        `, [currentUser.id]);
        const activeTab = req.query.tab === 'reservations' ? 'reservations-tab' : 'profile-tab';

        return res.render('owner-profile', {
            currentUser,
            myRestaurants,
            bookings,
            unreadBookingCount: Number(unreadRows[0].unread_count),
            activeTab,
            stats: { restaurantsCount: myRestaurants.length }
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error on owner dashboard');
    }
});

app.post('/owner/restaurants/add', handleRestaurantImageUpload, async (req, res) => {
    try {
        const userEmail = req.cookies.user_email;
        if (!userEmail) return res.redirect('/?modal=login');

        const [users] = await db.query('SELECT * FROM users WHERE email = ?', [userEmail]);
        if (users.length === 0 || users[0].role !== 'owner') return res.redirect('/');
        const currentUser = users[0];

        const { name, cuisine, address, description, image } = req.body || {};
        const restaurant = {
            name: typeof name === 'string' ? name.trim() : '',
            cuisine: typeof cuisine === 'string' ? cuisine.trim() : '',
            address: typeof address === 'string' ? address.trim() : '',
            description: typeof description === 'string' ? description.trim() : ''
        };

        if (!restaurant.name || !restaurant.cuisine || !restaurant.address || !restaurant.description) {
            return sendRestaurantError(
                res,
                'Restaurant details are incomplete',
                new Error('Name, cuisine, address, and description are required.'),
                400
            );
        }
        if (restaurant.name.length > 150 || restaurant.cuisine.length > 100 || restaurant.address.length > 255) {
            return sendRestaurantError(
                res,
                'Restaurant details are too long',
                new Error('Name must be at most 150 characters, cuisine 100, and address 255.'),
                400
            );
        }
        if (restaurant.description.length > 2000) {
            return sendRestaurantError(
                res,
                'Restaurant description is too long',
                new Error('Description must be at most 2000 characters.'),
                400
            );
        }

        const imagePath = req.file
            ? '/uploads/' + req.file.filename
            : (typeof image === 'string' && image.trim() ? image.trim() : '/images/No%20image.png');

        await db.query(
            'INSERT INTO restaurants (name, cuisine, address, description, image, owner_id, rating) VALUES (?, ?, ?, ?, ?, ?, 0)',
            [restaurant.name, restaurant.cuisine, restaurant.address, restaurant.description, imagePath, currentUser.id]
        );

        return res.redirect('/owner-dashboard');
    } catch (err) {
        console.error('Failed to add restaurant:', err);
        return sendRestaurantError(res, 'Failed to add restaurant', err);
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

        const [result] = await db.query(
            'DELETE FROM restaurants WHERE id = ? AND owner_id = ?',
            [restaurantId, users[0].id]
        );
        if (result.affectedRows === 0) return res.status(404).send('Restaurant not found or not owned by this account.');

        return res.redirect('/owner-dashboard');
    } catch (err) {
        console.error('Failed to delete restaurant:', err);
        return sendRestaurantError(res, 'Failed to delete restaurant', err);
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
            statusMessage: messages[req.query.status] || null
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
            'SELECT id FROM restaurants WHERE id = ? AND owner_id = ?',
            [restaurantId, owner.id]
        );
        if (restaurants.length === 0) return res.status(404).send('Restaurant not found.');

        const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
        const description = typeof req.body.description === 'string' ? req.body.description.trim() : '';
        const priceText = typeof req.body.price === 'string' ? req.body.price.trim() : '';
        if (!name || name.length > 150 || !/^\d+(?:\.\d{1,2})?$/.test(priceText) || description.length > 2000) {
            return sendRestaurantError(
                res,
                'Invalid menu item',
                new Error('Enter an item name (up to 150 characters), a valid non-negative price with up to two decimals, and a description up to 2000 characters.'),
                400
            );
        }

        const price = Number(priceText);
        if (!Number.isFinite(price) || price > 99999999.99) {
            return sendRestaurantError(res, 'Invalid menu item', new Error('Price is outside the allowed range.'), 400);
        }

        await db.query(
            'INSERT INTO menu_items (restaurant_id, name, description, price) VALUES (?, ?, ?, ?)',
            [restaurantId, name, description || null, price]
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
        if (!Number.isSafeInteger(restaurantId) || restaurantId <= 0 ||
            !Number.isSafeInteger(itemId) || itemId <= 0) {
            return res.status(404).send('Restaurant or menu item not found.');
        }
        const [restaurants] = await db.query(
            'SELECT id FROM restaurants WHERE id = ? AND owner_id = ?',
            [restaurantId, owner.id]
        );
        if (restaurants.length === 0) return res.status(404).send('Restaurant not found.');

        const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
        const description = typeof req.body.description === 'string' ? req.body.description.trim() : '';
        const priceText = typeof req.body.price === 'string' ? req.body.price.trim() : '';
        if (!name || name.length > 150 || !/^\d+(?:\.\d{1,2})?$/.test(priceText) || description.length > 2000) {
            return sendRestaurantError(res, 'Invalid menu item', new Error('Check the item name, price, and description.'), 400);
        }

        const price = Number(priceText);
        if (!Number.isFinite(price) || price > 99999999.99) {
            return sendRestaurantError(res, 'Invalid menu item', new Error('Price is outside the allowed range.'), 400);
        }

        const [items] = await db.query(
            'SELECT id FROM menu_items WHERE id = ? AND restaurant_id = ?',
            [itemId, restaurantId]
        );
        if (items.length === 0) return res.status(404).send('Menu item not found.');

        await db.query(
            'UPDATE menu_items SET name = ?, description = ?, price = ? WHERE id = ? AND restaurant_id = ?',
            [name, description || null, price, itemId, restaurantId]
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
        if (!Number.isSafeInteger(restaurantId) || restaurantId <= 0 ||
            !Number.isSafeInteger(itemId) || itemId <= 0) {
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
        const owner = await getOwnerFromRequest(req);
        if (!owner) return res.redirect('/?modal=login');

        const bookingId = Number(req.params.id);
        const status = req.body.status;
        if (!Number.isSafeInteger(bookingId) || bookingId <= 0 ||
            !['confirmed', 'cancelled'].includes(status)) {
            return res.status(400).send('Invalid booking update.');
        }

        const [result] = await db.query(`
            UPDATE bookings b
            JOIN restaurants r ON r.id = b.restaurant_id
            SET b.status = ?, b.owner_read_at = COALESCE(b.owner_read_at, CURRENT_TIMESTAMP)
            WHERE b.id = ? AND r.owner_id = ? AND b.status = 'pending'
        `, [status, bookingId, owner.id]);
        if (result.affectedRows === 0) return res.status(404).send('Pending booking not found.');

        return res.redirect('/owner-dashboard?tab=reservations');
    } catch (err) {
        console.error('Failed to update booking status:', err);
        return sendRestaurantError(res, 'Failed to update booking', err);
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
        await db.query('DELETE FROM users WHERE id = ?', [req.params.id]);
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
        await db.query('DELETE FROM restaurants WHERE id = ?', [req.params.id]);
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

        const [targetRev] = await db.query('SELECT is_hidden FROM reviews WHERE id = ?', [req.params.id]);
        if (targetRev.length > 0) {
            await db.query('UPDATE reviews SET is_hidden = ? WHERE id = ?', [targetRev[0].is_hidden ? 0 : 1, req.params.id]);
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
        await db.query('DELETE FROM reviews WHERE id = ?', [req.params.id]);
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

app.get('/profile', async (req, res) => {
    try {
        const userEmail = req.cookies.user_email;
        if (!userEmail) return res.redirect('/?modal=login');

        const [users] = await db.query('SELECT * FROM users WHERE email = ?', [userEmail]);
        if (users.length === 0) return res.redirect('/');
        const currentUser = users[0];

        if (currentUser.role === 'owner') return res.redirect('/owner-dashboard');

        const [myReviews] = await db.query(`
            SELECT reviews.*, restaurants.name as restaurant_name 
            FROM reviews JOIN restaurants ON reviews.restaurant_id = restaurants.id 
            WHERE reviews.user_id = ? ORDER BY reviews.id DESC
        `, [currentUser.id]);

        let favorites = [];
        try {
            const [favs] = await db.query(`
                SELECT restaurants.* FROM favorites 
                JOIN restaurants ON favorites.restaurant_id = restaurants.id 
                WHERE favorites.user_id = ?
            `, [currentUser.id]);
            favorites = favs;
        } catch (e) {
            favorites = [];
        }

        res.render('profile', { currentUser, myReviews, favorites, stats: { ratedCount: myReviews.length } });
    } catch (err) {
        console.error(err);
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
        res.redirect('/profile');
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error during profile update');
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

app.listen(PORT, () => {
    console.log(`Server is running at: http://localhost:${PORT}`);
});
