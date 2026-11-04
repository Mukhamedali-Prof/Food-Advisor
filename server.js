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

        const [allUsers] = await db.query('SELECT * FROM users');
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
            users: allUsers,
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
    res.render('register');
});

app.post('/register', async (req, res) => {
    const { username, email, role } = req.body;
    try {
        await db.query('INSERT INTO users (username, email, role) VALUES (?, ?, ?)', [username, email, role || 'customer']);
        res.cookie('user_email', email, { maxAge: 24 * 60 * 60 * 1000 });
        res.redirect('/');
    } catch (err) {
        console.error(err);
        res.render('register', { error: 'User with this email already exists or an error occurred!' });
    }
});

app.get('/login', (req, res) => {
    res.render('login');
});

app.post('/login', async (req, res) => {
    const { email } = req.body;
    try {
        const [users] = await db.query('SELECT * FROM users WHERE email = ?', [email]);
        if (users.length > 0) {
            res.cookie('user_email', email, { maxAge: 24 * 60 * 60 * 1000 });
            res.redirect('/');
        } else {
            res.render('login', { error: 'User with this email not found!' });
        }
    } catch (err) {
        console.error(err);
        res.render('login', { error: 'Server error during login attempt' });
    }
});

app.get('/logout', (req, res) => {
    res.clearCookie('user_email');
    res.redirect('/');
});

app.listen(PORT, () => {
    console.log(`Server is running at: http://localhost:${PORT}`);
});