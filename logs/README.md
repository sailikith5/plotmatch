# Log files

Capture the output of the SQL and MongoDB scripts here. The template says
"Log files are also fine" for the DDL/DML/NoSQL sections of the report.

    mysql -u root -p --table plotmatch < db/04_dml.sql     > logs/dml.log
    mysql -u root -p --table plotmatch < db/05_queries.sql > logs/queries.log
    mongosh "$MONGODB_URI" db/mongo/03_vector_rud.js       > logs/vector_rud.log

`.gitignore` excludes `*.log`, so remove that line if you want the logs in the
repository as submission evidence.
