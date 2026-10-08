# classsync
A Real-Time Timetable and Classroom Allocation System for SPIT (No More Wandering, Just Learning) Teachers update room status, students select their batch and semester, and everyone knows where the class is, instantly.

## Run locally

The app is in `files/classsync` (Node.js + Express, PostgreSQL, Redis; frontend is plain HTML, CSS and JavaScript).

```bash
cd files/classsync
cp .env.example .env   # set JWT_SECRET and SUPERADMIN_EMAIL
npm install
npm start              # http://localhost:3000; tables are created/upgraded on start
```

Log in with the super admin email (the code prints in the terminal when SMTP is not set), open **Admin** to add floors, classrooms, labs and teachers, and **Timetable** to plan each batch's week. Students log in with their `@spit.ac.in` email.
