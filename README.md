# Food Advisor Web Application

**Food Advisor** is a client-server web application developed for the **F28WP Web Programming** coursework. It enables users to discover restaurants, explore menus, submit ratings and reviews, and manage reservations, while providing dedicated management tools for Restaurant Owners and Administrators.

## Technology Stack

* **Frontend:** HTML5, CSS3, JavaScript, jQuery, EJS templates, Web Storage (`localStorage` / `sessionStorage`)
* **Backend:** Node.js, Express, JSON data transfer
* **Database:** MySQL / MariaDB (`food_advisor_db`)

## Prerequisites

Ensure the following software is installed on the local machine before running the application:
* **Node.js** (LTS version recommended, e.g., Node 18+)
* **MySQL** or **MariaDB** (e.g., MySQL Server or XAMPP)

## Step-by-Step Local Setup

### 1. Extract the Project Archive

Extract the submitted ZIP folder and open a terminal inside the root project directory:

```bash
cd Food-Advisor
```

### 2. Install Project Dependencies

```bash
npm install
```

### 3. Set Up the MySQL Database

1. Start the local **MySQL / MariaDB** server.
2. Create the database `food_advisor_db` via a database client (phpMyAdmin, MySQL Workbench, DBeaver) or CLI:

```sql
CREATE DATABASE IF NOT EXISTS food_advisor_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

3. Import the database schema from `schema.sql` (creates all required tables: `users`, `restaurants`, `menu_items`, `reviews`, `bookings`, and `favorites` with foreign key constraints):

* **Windows (Command Prompt with XAMPP):**
  ```cmd
  "C:\xampp\mysql\bin\mysql.exe" -u root -p food_advisor_db < schema.sql
  ```
* **Linux / macOS (Terminal):**
  ```bash
  mysql -u root -p food_advisor_db < schema.sql
  ```
* **GUI Client (phpMyAdmin / MySQL Workbench / DBeaver):** select `food_advisor_db`, open the **SQL** tab, load `schema.sql`, and execute the script.

### 4. Verify Database Configuration

Check the database connection settings in the project configuration file / `.env` (default local setup expects `host: localhost`, `user: root`, `database: food_advisor_db`, and your local MySQL password).

> Ensure the local `uploads/` directory exists (or is writable) so user avatars and restaurant images uploaded through the web interface are stored properly.

### 5. Run the Application Locally

Start the Node.js server:

```bash
npm start
```
*(Alternatively, run the main server entry file directly, e.g., `node server.js` or `node app.js`, as defined in `package.json`.)*

Open your browser and navigate to `http://localhost:3000` (or the port printed in the console).

### 6. Log in as Admin to test fuctionality

Go to http://localhost:3000/admin
Use email "admin@example.com" and password "Admin123!"

## Application Roles & Key Functionality

The application implements role-based access control across three user roles:

* **Customer:**
  * Register, log in, and manage personal profile details and avatar.
  * Browse, search, and filter restaurants by cuisine, location, rating, and price range.
  * View restaurant details and menu items, save favorite restaurants, submit/manage ratings and reviews, and create table bookings.
* **Restaurant Owner (`owner`):**
  * Add and update details for their own restaurants (with client-side and server-side validation, including restaurant name rules up to 30 characters and image uploads).
  * Manage menu items (add, edit, delete dishes) and respond to/manage customer table bookings.
* **Administrator (`admin`):**
  * Manage registered Customer and Restaurant Owner accounts (block/unblock or delete users).
  * Oversee all restaurants (edit restaurant name and location, hide/unhide venues from public search, or delete restaurants).
  * Moderate customer reviews (hide/unhide or delete inappropriate feedback).