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
            res.cookie('user_email', email, { maxAge: 24 * 60 * 60 * 1000 });
            res.redirect('/');
        } else {
            res.redirect('/?modal=login&error=' + encodeURIComponent('Invalid email or password!'));
        }
    } catch (err) {
        console.error(err);
        res.redirect('/?modal=login&error=' + encodeURIComponent('Server error during login attempt'));
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

        res.render('admin-login', { error: null });
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

app.post('/profile/update', async (req, res) => {
    try {
        const userEmail = req.cookies.user_email;
        const { username, avatar } = req.body;

        if (userEmail) {
            await db.query('UPDATE users SET username = ?, avatar = ? WHERE email = ?', [username, avatar, userEmail]);
        }
        res.redirect('/profile');
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    }
});

app.listen(PORT, () => {
    console.log(`Server is running at: http://localhost:${PORT}`);
});