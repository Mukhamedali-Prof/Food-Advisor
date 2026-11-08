const multer = require('multer');
const path = require('path');
const fs = require('fs');

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = 'public/uploads';
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'avatar-' + uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

const express = require('express');
const cookieParser = require('cookie-parser');
const db = require('./config/db');

const app = express();
const PORT = 3000;

app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static('public'));

app.get('/', async (req, res) => {
    try {
        const userEmail = req.cookies.user_email;
        let currentUser = null;

        if (userEmail) {
            const [users] = await db.query('SELECT * FROM users WHERE email = ?', [userEmail]);
            if (users.length > 0) {
                currentUser = users[0];
            }
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

        res.render('index', {
            currentUser,
            stats: stats[0],
            topRestaurants,
            recentReviews
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    }
});

app.get('/register', (req, res) => {
    res.redirect('/');
});

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
        res.redirect('/?modal=register&error=' + encodeURIComponent('User with this email already exists or an error occurred!'));
    }
});

app.get('/login', (req, res) => {
    res.redirect('/');
});

app.post('/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const [users] = await db.query('SELECT * FROM users WHERE email = ? AND password = ?', [email, password]);
        if (users.length > 0) {
            const user = users[0];
            res.cookie('user_email', email, { maxAge: 24 * 60 * 60 * 1000 });

            if (user.role === 'owner') {
                return res.redirect('/owner-dashboard');
            } else if (user.role === 'admin') {
                return res.redirect('/admin');
            } else {
                return res.redirect('/profile');
            }
        } else {
            res.redirect('/?modal=login&error=' + encodeURIComponent('Invalid email or password!'));
        }
    } catch (err) {
        console.error(err);
        res.redirect('/?modal=login&error=' + encodeURIComponent('Server error during login attempt'));
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

        const stats = { restaurantsCount: myRestaurants.length };
        res.render('owner-profile', { currentUser, myRestaurants, stats });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error on owner dashboard');
    }
});

app.post('/owner/restaurants/add', async (req, res) => {
    try {
        const userEmail = req.cookies.user_email;
        if (!userEmail) return res.redirect('/');

        const [users] = await db.query('SELECT * FROM users WHERE email = ?', [userEmail]);
        if (users.length === 0 || users[0].role !== 'owner') return res.redirect('/');
        const currentUser = users[0];

        const { name, cuisine, address, description, image } = req.body;

        try {
            await db.query('INSERT INTO restaurants (name, cuisine, address, description, image, owner_id, rating) VALUES (?, ?, ?, ?, ?, ?, 0.0)',
                [name, cuisine, address, description, image || '/uploads/default-restaurant.jpg', currentUser.id]);
        } catch (e) {
            await db.query('INSERT INTO restaurants (name, cuisine, address, description, image, user_id, rating) VALUES (?, ?, ?, ?, ?, ?, 0.0)',
                [name, cuisine, address, description, image || '/uploads/default-restaurant.jpg', currentUser.id]);
        }

        res.redirect('/owner-dashboard');
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error while adding restaurant');
    }
});

app.get('/admin', async (req, res) => {
    try {
        const userEmail = req.cookies.user_email;
        let currentUser = null;

        if (userEmail) {
            const [users] = await db.query('SELECT * FROM users WHERE email = ?', [userEmail]);
            if (users.length > 0) {
                currentUser = users[0];
            }
        }

        if (currentUser && currentUser.role === 'admin') {
            const [allUsers] = await db.query('SELECT * FROM users');
            const [allRestaurants] = await db.query('SELECT * FROM restaurants');
            const [allReviews] = await db.query(`
                SELECT reviews.*, users.username, restaurants.name as restaurant_name 
                FROM reviews 
                JOIN users ON reviews.user_id = users.id 
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
            res.render('admin-login', { error: 'Invalid admin credentials or access denied!', currentUser: null });
        }
    } catch (err) {
        console.error(err);
        res.render('admin-login', { error: 'Server error during admin login', currentUser: null });
    }
});

app.post('/admin/users/delete/:id', async (req, res) => {
    try {
        const userEmail = req.cookies.user_email;
        if (!userEmail) return res.redirect('/admin');
        const [adminCheck] = await db.query('SELECT * FROM users WHERE email = ? AND role = "admin"', [userEmail]);
        if (adminCheck.length === 0) return res.redirect('/');

        const userId = req.params.id;
        if (adminCheck[0].id == userId) {
            return res.redirect('/admin');
        }

        await db.query('DELETE FROM users WHERE id = ?', [userId]);
        res.redirect('/admin');
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    }
});

app.post('/admin/restaurants/delete/:id', async (req, res) => {
    try {
        const userEmail = req.cookies.user_email;
        if (!userEmail) return res.redirect('/admin');
        const [adminCheck] = await db.query('SELECT * FROM users WHERE email = ? AND role = "admin"', [userEmail]);
        if (adminCheck.length === 0) return res.redirect('/');

        await db.query('DELETE FROM restaurants WHERE id = ?', [req.params.id]);
        res.redirect('/admin');
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    }
});

app.post('/admin/reviews/delete/:id', async (req, res) => {
    try {
        const userEmail = req.cookies.user_email;
        if (!userEmail) return res.redirect('/admin');
        const [adminCheck] = await db.query('SELECT * FROM users WHERE email = ? AND role = "admin"', [userEmail]);
        if (adminCheck.length === 0) return res.redirect('/');

        await db.query('DELETE FROM reviews WHERE id = ?', [req.params.id]);
        res.redirect('/admin');
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
            res.render('admin-login', { error: 'Invalid admin credentials or access denied!' });
        }
    } catch (err) {
        console.error(err);
        res.render('admin-login', { error: 'Server error during admin login' });
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
                WHERE favorites.user_id = ?
            `, [currentUser.id]);
            favorites = favs;
        } catch (e) {
            favorites = [];
        }

        const stats = {
            ratedCount: myReviews.length
        };

        res.render('profile', { currentUser, myReviews, favorites, stats });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    }
});

app.post('/profile/update', upload.single('avatarFile'), async (req, res) => {
    try {
        const userEmail = req.cookies.user_email;
        const { username } = req.body;

        if (!userEmail) return res.redirect('/');

        const [users] = await db.query('SELECT * FROM users WHERE email = ?', [userEmail]);
        if (users.length === 0) return res.redirect('/');
        const currentUser = users[0];

        let avatarPath = currentUser.avatar;
        if (req.file) {
            avatarPath = '/uploads/' + req.file.filename;
        }

        await db.query('UPDATE users SET username = ?, avatar = ? WHERE email = ?', [username, avatarPath, userEmail]);

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

        if (!userEmail) {
            return res.redirect('/');
        }

        if (!newPassword || newPassword.trim() === '') {
            return res.redirect('/profile?error=' + encodeURIComponent('Password cannot be empty!'));
        }

        await db.query('UPDATE users SET password = ? WHERE email = ?', [newPassword, userEmail]);

        res.redirect('/profile?success=' + encodeURIComponent('Password updated successfully!'));
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error during password update');
    }
});

app.post('/admin/users/delete/:id', async (req, res) => {
    try {
        const userEmail = req.cookies.user_email;
        if (!userEmail) return res.redirect('/admin');
        const [adminCheck] = await db.query('SELECT * FROM users WHERE email = ? AND role = "admin"', [userEmail]);
        if (adminCheck.length === 0) return res.redirect('/');

        const userId = req.params.id;
        if (adminCheck[0].id == userId) {
            return res.redirect('/admin?error=' + encodeURIComponent('You cannot delete your own admin account!'));
        }

        await db.query('DELETE FROM users WHERE id = ?', [userId]);
        res.redirect('/admin');
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error during user deletion');
    }
});

app.post('/admin/users/toggle/:id', async (req, res) => {
    try {
        const userEmail = req.cookies.user_email;
        if (!userEmail) return res.redirect('/admin');
        const [adminCheck] = await db.query('SELECT * FROM users WHERE email = ? AND role = "admin"', [userEmail]);
        if (adminCheck.length === 0) return res.redirect('/');

        const userId = req.params.id;
        if (adminCheck[0].id == userId) return res.redirect('/admin'); // Нельзя заблокировать самого себя

        const [targetUser] = await db.query('SELECT is_blocked FROM users WHERE id = ?', [userId]);
        if (targetUser.length > 0) {
            const newStatus = targetUser[0].is_blocked ? 0 : 1;
            await db.query('UPDATE users SET is_blocked = ? WHERE id = ?', [newStatus, userId]);
        }
        res.redirect('/admin');
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    }
});

app.post('/admin/users/delete/:id', async (req, res) => {
    try {
        const userEmail = req.cookies.user_email;
        if (!userEmail) return res.redirect('/admin');
        const [adminCheck] = await db.query('SELECT * FROM users WHERE email = ? AND role = "admin"', [userEmail]);
        if (adminCheck.length === 0) return res.redirect('/');

        const userId = req.params.id;
        if (adminCheck[0].id == userId) return res.redirect('/admin');

        await db.query('DELETE FROM users WHERE id = ?', [userId]);
        res.redirect('/admin');
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    }
});

app.post('/admin/restaurants/toggle/:id', async (req, res) => {
    try {
        const userEmail = req.cookies.user_email;
        if (!userEmail) return res.redirect('/admin');
        const [adminCheck] = await db.query('SELECT * FROM users WHERE email = ? AND role = "admin"', [userEmail]);
        if (adminCheck.length === 0) return res.redirect('/');

        const restId = req.params.id;
        const [targetRest] = await db.query('SELECT is_hidden FROM restaurants WHERE id = ?', [restId]);
        if (targetRest.length > 0) {
            const newHiddenStatus = targetRest[0].is_hidden ? 0 : 1;
            await db.query('UPDATE restaurants SET is_hidden = ? WHERE id = ?', [newHiddenStatus, restId]);
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
        if (!userEmail) return res.redirect('/admin');
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
        if (!userEmail) return res.redirect('/admin');
        const [adminCheck] = await db.query('SELECT * FROM users WHERE email = ? AND role = "admin"', [userEmail]);
        if (adminCheck.length === 0) return res.redirect('/');

        const revId = req.params.id;
        const [targetRev] = await db.query('SELECT is_hidden FROM reviews WHERE id = ?', [revId]);
        if (targetRev.length > 0) {
            const newHiddenStatus = targetRev[0].is_hidden ? 0 : 1;
            await db.query('UPDATE reviews SET is_hidden = ? WHERE id = ?', [newHiddenStatus, revId]);
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
        if (!userEmail) return res.redirect('/admin');
        const [adminCheck] = await db.query('SELECT * FROM users WHERE email = ? AND role = "admin"', [userEmail]);
        if (adminCheck.length === 0) return res.redirect('/');

        await db.query('DELETE FROM reviews WHERE id = ?', [req.params.id]);
        res.redirect('/admin');
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    }
});

app.post('/admin/restaurants/delete/:id', async (req, res) => {
    try {
        const userEmail = req.cookies.user_email;
        if (!userEmail) return res.redirect('/admin');
        const [adminCheck] = await db.query('SELECT * FROM users WHERE email = ? AND role = "admin"', [userEmail]);
        if (adminCheck.length === 0) return res.redirect('/');

        const restaurantId = req.params.id;
        await db.query('DELETE FROM restaurants WHERE id = ?', [restaurantId]);
        res.redirect('/admin');
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error during restaurant deletion');
    }
});

app.post('/admin/reviews/delete/:id', async (req, res) => {
    try {
        const userEmail = req.cookies.user_email;
        if (!userEmail) return res.redirect('/admin');
        const [adminCheck] = await db.query('SELECT * FROM users WHERE email = ? AND role = "admin"', [userEmail]);
        if (adminCheck.length === 0) return res.redirect('/');

        const reviewId = req.params.id;
        await db.query('DELETE FROM reviews WHERE id = ?', [reviewId]);
        res.redirect('/admin');
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error during review deletion');
    }
});

app.listen(PORT, () => {
    console.log(`Server is running at: http://localhost:${PORT}`);
});